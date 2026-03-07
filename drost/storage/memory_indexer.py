from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

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

            return {"indexed": indexed, "skipped": skipped, "removed": removed}

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
