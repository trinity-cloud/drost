from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.embeddings import EmbeddingService
from drost.memory_files import MemoryFiles
from drost.storage.database import SQLiteStore

logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class MemorySourceFile:
    relative_path: str
    absolute_path: Path
    source_kind: str
    title: str


@dataclass(slots=True, frozen=True)
class GraphEntityRecord:
    entity_type: str
    entity_id: str
    title: str
    entity_path: str
    summary_path: str
    updated_at: str


@dataclass(slots=True, frozen=True)
class GraphAliasRecord:
    entity_type: str
    entity_id: str
    alias: str
    path: str
    updated_at: str


@dataclass(slots=True, frozen=True)
class GraphRelationRecord:
    relation_id: str
    from_entity_type: str
    from_entity_id: str
    relation_type: str
    to_entity_type: str
    to_entity_id: str
    relation_text: str
    confidence: float | None
    path: str
    line_start: int
    line_end: int
    updated_at: str


class WorkspaceMemoryIndexer:
    def __init__(
        self,
        *,
        workspace_dir: str | Path,
        store: SQLiteStore,
        embeddings: EmbeddingService,
    ) -> None:
        self.workspace_dir = Path(workspace_dir).expanduser()
        self._store = store
        self._embeddings = embeddings
        self._lock = asyncio.Lock()
        self._memory_files = MemoryFiles(self.workspace_dir)

    async def sync(self) -> dict[str, int]:
        async with self._lock:
            self._memory_files.ensure_layout()
            candidates = {item.relative_path: item for item in self._collect_candidates()}
            existing = {str(row.get("path") or ""): row for row in self._store.list_indexed_files()}

            indexed = 0
            skipped = 0
            removed = 0

            for relative_path, candidate in candidates.items():
                existing_row = existing.pop(relative_path, None)
                try:
                    text = candidate.absolute_path.read_text(encoding="utf-8", errors="replace")
                except Exception as exc:
                    logger.warning("Failed reading workspace memory file for indexing: %s", exc)
                    continue

                stripped = text.strip()
                if not stripped:
                    if existing_row is not None:
                        self._store.remove_indexed_file(relative_path)
                        removed += 1
                    continue

                file_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                if existing_row is not None and str(existing_row.get("file_hash") or "") == file_hash:
                    skipped += 1
                    continue

                updated_at = datetime.fromtimestamp(
                    candidate.absolute_path.stat().st_mtime,
                    tz=UTC,
                ).isoformat()
                chunks = self._build_chunks(candidate=candidate, text=text, updated_at=updated_at)
                if not chunks:
                    if existing_row is not None:
                        self._store.remove_indexed_file(relative_path)
                        removed += 1
                    continue

                for chunk in chunks:
                    chunk["embedding"] = await self._embeddings.embed_document(
                        str(chunk.get("content") or ""),
                        title=str(chunk.get("title") or candidate.title),
                    )

                self._store.replace_indexed_file(
                    path=relative_path,
                    source_kind=candidate.source_kind,
                    title=candidate.title,
                    file_hash=file_hash,
                    updated_at=updated_at,
                    chunks=chunks,
                )
                indexed += 1

            for stale_path in existing:
                self._store.remove_indexed_file(stale_path)
                removed += 1

            entities, aliases, relations = self._build_graph_index()
            self._store.replace_graph_index(
                entities=[asdict(record) for record in entities],
                aliases=[asdict(record) for record in aliases],
                relations=[asdict(record) for record in relations],
            )

            return {
                "indexed": indexed,
                "skipped": skipped,
                "removed": removed,
                "graph_entities": len(entities),
                "graph_aliases": len(aliases),
                "graph_relations": len(relations),
            }

    def _collect_candidates(self) -> list[MemorySourceFile]:
        out: list[MemorySourceFile] = []
        memory_md = self.workspace_dir / "MEMORY.md"
        if memory_md.exists() and memory_md.is_file():
            out.append(
                MemorySourceFile(
                    relative_path="MEMORY.md",
                    absolute_path=memory_md,
                    source_kind="workspace_memory",
                    title="MEMORY.md",
                )
            )

        daily_dir = self.workspace_dir / "memory" / "daily"
        if daily_dir.exists():
            for path in sorted(daily_dir.glob("*.md")):
                rel = path.relative_to(self.workspace_dir).as_posix()
                out.append(
                    MemorySourceFile(
                        relative_path=rel,
                        absolute_path=path,
                        source_kind="daily_memory",
                        title=f"daily/{path.stem}",
                    )
                )

        entities_root = self.workspace_dir / "memory" / "entities"
        if entities_root.exists():
            for path in sorted(entities_root.glob("*/*/items.md")):
                rel = path.relative_to(self.workspace_dir).as_posix()
                title = "/".join(path.parts[-3:-1])
                out.append(
                    MemorySourceFile(
                        relative_path=rel,
                        absolute_path=path,
                        source_kind="entity_item",
                        title=title,
                    )
                )
            for path in sorted(entities_root.glob("*/*/summary.md")):
                rel = path.relative_to(self.workspace_dir).as_posix()
                title = "/".join(path.parts[-3:-1])
                out.append(
                    MemorySourceFile(
                        relative_path=rel,
                        absolute_path=path,
                        source_kind="entity_summary",
                        title=title,
                    )
                )
            for path in sorted(entities_root.glob("*/*/aliases.md")):
                rel = path.relative_to(self.workspace_dir).as_posix()
                title = "/".join(path.parts[-3:-1])
                out.append(
                    MemorySourceFile(
                        relative_path=rel,
                        absolute_path=path,
                        source_kind="entity_alias",
                        title=title,
                    )
                )
            for path in sorted(entities_root.glob("*/*/relations.md")):
                rel = path.relative_to(self.workspace_dir).as_posix()
                title = "/".join(path.parts[-3:-1])
                out.append(
                    MemorySourceFile(
                        relative_path=rel,
                        absolute_path=path,
                        source_kind="entity_relation",
                        title=title,
                    )
                )
        return out

    def _build_chunks(
        self,
        *,
        candidate: MemorySourceFile,
        text: str,
        updated_at: str,
    ) -> list[dict[str, object]]:
        if candidate.source_kind == "entity_summary":
            stripped = text.strip()
            if not stripped:
                return []
            return [
                {
                    "title": candidate.title,
                    "content": stripped,
                    "line_start": 1,
                    "line_end": len(text.splitlines()) or 1,
                    "created_at": updated_at,
                    "derived_from": "",
                }
            ]
        if candidate.source_kind == "entity_alias":
            chunks: list[dict[str, object]] = []
            for line_no, alias in self._parse_alias_lines(text):
                chunks.append(
                    {
                        "title": candidate.title,
                        "content": f"{candidate.title} alias {alias}",
                        "line_start": line_no,
                        "line_end": line_no,
                        "created_at": updated_at,
                        "derived_from": "",
                    }
                )
            return chunks
        if candidate.source_kind == "entity_relation":
            chunks: list[dict[str, object]] = []
            for relation in self._parse_relation_blocks(text):
                relation_text = relation["relation_text"]
                if not relation_text:
                    continue
                content = (
                    f"{candidate.title} {relation['relation_type']} "
                    f"{relation['to_entity_type']}/{relation['to_entity_id']}\n{relation_text}"
                ).strip()
                chunks.append(
                    {
                        "title": candidate.title,
                        "content": content,
                        "line_start": relation["line_start"],
                        "line_end": relation["line_end"],
                        "created_at": updated_at,
                        "derived_from": relation["relation_id"],
                    }
                )
            return chunks

        blocks = self._split_blocks(text)
        chunks: list[dict[str, object]] = []
        for line_start, line_end, content in blocks:
            if self._is_heading_only(content):
                continue
            chunks.append(
                {
                    "title": candidate.title,
                    "content": content,
                    "line_start": line_start,
                    "line_end": line_end,
                    "created_at": updated_at,
                    "derived_from": "",
                }
            )
        return chunks

    @staticmethod
    def _split_blocks(text: str) -> list[tuple[int, int, str]]:
        lines = text.splitlines()
        blocks: list[tuple[int, int, str]] = []
        start: int | None = None
        acc: list[str] = []
        for idx, line in enumerate(lines, start=1):
            if line.strip():
                if start is None:
                    start = idx
                acc.append(line)
                continue
            if start is not None and acc:
                blocks.append((start, idx - 1, "\n".join(acc).strip()))
                start = None
                acc = []
        if start is not None and acc:
            blocks.append((start, len(lines) or start, "\n".join(acc).strip()))
        return blocks

    @staticmethod
    def _is_heading_only(content: str) -> bool:
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        if not lines:
            return True
        return len(lines) == 1 and lines[0].startswith("#")

    def _build_graph_index(
        self,
    ) -> tuple[list[GraphEntityRecord], list[GraphAliasRecord], list[GraphRelationRecord]]:
        entities_root = self.workspace_dir / "memory" / "entities"
        if not entities_root.exists():
            return [], [], []

        entities: list[GraphEntityRecord] = []
        aliases: list[GraphAliasRecord] = []
        relations: list[GraphRelationRecord] = []

        for entity_dir in sorted(path for path in entities_root.glob("*/*") if path.is_dir()):
            entity_type = entity_dir.parent.name
            entity_id = entity_dir.name
            summary_path = entity_dir / "summary.md"
            updated_at = self._updated_at(entity_dir)
            entities.append(
                GraphEntityRecord(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    title=f"{entity_type}/{entity_id}",
                    entity_path=entity_dir.relative_to(self.workspace_dir).as_posix(),
                    summary_path=summary_path.relative_to(self.workspace_dir).as_posix()
                    if summary_path.exists()
                    else "",
                    updated_at=updated_at,
                )
            )

            alias_path = entity_dir / "aliases.md"
            if alias_path.exists():
                alias_text = alias_path.read_text(encoding="utf-8", errors="replace")
                alias_updated_at = self._updated_at(alias_path)
                for _, alias in self._parse_alias_lines(alias_text):
                    aliases.append(
                        GraphAliasRecord(
                            entity_type=entity_type,
                            entity_id=entity_id,
                            alias=alias,
                            path=alias_path.relative_to(self.workspace_dir).as_posix(),
                            updated_at=alias_updated_at,
                        )
                    )

            relation_path = entity_dir / "relations.md"
            if relation_path.exists():
                relation_text = relation_path.read_text(encoding="utf-8", errors="replace")
                relation_updated_at = self._updated_at(relation_path)
                for relation in self._parse_relation_blocks(relation_text):
                    relations.append(
                        GraphRelationRecord(
                            relation_id=str(relation["relation_id"]),
                            from_entity_type=entity_type,
                            from_entity_id=entity_id,
                            relation_type=str(relation["relation_type"]),
                            to_entity_type=str(relation["to_entity_type"]),
                            to_entity_id=str(relation["to_entity_id"]),
                            relation_text=str(relation["relation_text"]),
                            confidence=relation["confidence"],
                            path=relation_path.relative_to(self.workspace_dir).as_posix(),
                            line_start=int(relation["line_start"]),
                            line_end=int(relation["line_end"]),
                            updated_at=relation_updated_at,
                        )
                    )

        return entities, aliases, relations

    @staticmethod
    def _updated_at(path: Path) -> str:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()

    @staticmethod
    def _parse_alias_lines(text: str) -> list[tuple[int, str]]:
        aliases: list[tuple[int, str]] = []
        for line_no, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped.startswith("- "):
                continue
            alias = stripped[2:].strip()
            if alias:
                aliases.append((line_no, alias))
        return aliases

    @classmethod
    def _parse_relation_blocks(cls, text: str) -> list[dict[str, Any]]:
        relations: list[dict[str, Any]] = []
        for line_start, line_end, block in cls._split_blocks(text):
            lines = [line.rstrip() for line in block.splitlines() if line.strip()]
            if not lines:
                continue
            if lines[0].strip().startswith("#"):
                continue

            meta = lines[0].strip()
            relation_id = cls._extract_tag(meta, "id")
            relation_type = cls._extract_tag(meta, "rel")
            to_ref = cls._extract_tag(meta, "to")
            if not relation_id or not relation_type or not to_ref or "/" not in to_ref:
                continue
            to_entity_type, to_entity_id = to_ref.split("/", 1)
            confidence_raw = cls._extract_tag(meta, "conf")
            confidence: float | None = None
            if confidence_raw:
                try:
                    confidence = float(confidence_raw)
                except ValueError:
                    confidence = None

            statement_lines = [
                line.strip()
                for line in lines[1:]
                if line.strip() and not line.strip().startswith("[source:")
            ]
            relation_text = " ".join(statement_lines).strip()
            relations.append(
                {
                    "relation_id": relation_id,
                    "relation_type": relation_type,
                    "to_entity_type": to_entity_type,
                    "to_entity_id": to_entity_id,
                    "relation_text": relation_text,
                    "confidence": confidence,
                    "line_start": line_start,
                    "line_end": line_end,
                }
            )
        return relations

    @staticmethod
    def _extract_tag(text: str, name: str) -> str:
        match = re.search(rf"\[{re.escape(name)}:([^\]]+)\]", text)
        if not match:
            return ""
        return match.group(1).strip()
