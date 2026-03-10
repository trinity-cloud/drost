from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path


def _slug(value: str) -> str:
    lowered = str(value or "").strip().lower()
    lowered = re.sub(r"[^a-z0-9_-]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    return lowered


def _current_date() -> str:
    return datetime.now(UTC).date().isoformat()


def _ensure_trailing_newline(text: str) -> str:
    return text if text.endswith("\n") else text + "\n"


def _normalize_alias(value: str) -> str:
    lowered = str(value or "").strip().casefold()
    return re.sub(r"\s+", " ", lowered)


def slugify_memory_key(value: str) -> str:
    return _slug(value)


def normalize_alias_value(value: str) -> str:
    return _normalize_alias(value)


def _next_fact_id(existing: str, *, entity_type: str, entity_id: str) -> str:
    pattern = re.compile(r"\[id:([a-z0-9_-]+/[a-z0-9_-]+)/(\d{4})\]")
    max_n = 0
    expected_prefix = f"{entity_type}/{entity_id}"
    for match in pattern.finditer(existing):
        if match.group(1) != expected_prefix:
            continue
        try:
            max_n = max(max_n, int(match.group(2)))
        except ValueError:
            continue
    return f"{entity_type}/{entity_id}/{max_n + 1:04d}"


def _next_relation_id(existing: str, *, entity_type: str, entity_id: str) -> str:
    pattern = re.compile(r"\[id:([a-z0-9_-]+/[a-z0-9_-]+)/relations/(\d{4})\]")
    max_n = 0
    expected_prefix = f"{entity_type}/{entity_id}"
    for match in pattern.finditer(existing):
        if match.group(1) != expected_prefix:
            continue
        try:
            max_n = max(max_n, int(match.group(2)))
        except ValueError:
            continue
    return f"{entity_type}/{entity_id}/relations/{max_n + 1:04d}"


@dataclass(slots=True, frozen=True)
class EntityFactWriteResult:
    path: Path
    entity_type: str
    entity_id: str
    fact_id: str | None
    created: bool


@dataclass(slots=True, frozen=True)
class EntityAliasWriteResult:
    path: Path
    entity_type: str
    entity_id: str
    alias: str
    created: bool


@dataclass(slots=True, frozen=True)
class EntityRelationWriteResult:
    path: Path
    from_entity_type: str
    from_entity_id: str
    relation_id: str | None
    relation_type: str
    to_ref: str
    created: bool


class MemoryFiles:
    def __init__(self, workspace_dir: str | Path) -> None:
        self.workspace_dir = Path(workspace_dir).expanduser()

    @property
    def daily_dir(self) -> Path:
        return self.workspace_dir / "memory" / "daily"

    @property
    def entities_dir(self) -> Path:
        return self.workspace_dir / "memory" / "entities"

    @property
    def state_dir(self) -> Path:
        return self.workspace_dir / "state"

    def ensure_layout(self) -> None:
        self.daily_dir.mkdir(parents=True, exist_ok=True)
        self.entities_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def daily_path(self, day: str | date | None = None) -> Path:
        if day is None:
            date_text = _current_date()
        elif isinstance(day, date):
            date_text = day.isoformat()
        else:
            date_text = str(day).strip() or _current_date()
        return self.daily_dir / f"{date_text}.md"

    def append_daily_bullets(self, bullets: list[str], *, day: str | date | None = None) -> Path:
        self.ensure_layout()
        path = self.daily_path(day)
        cleaned = [str(item or "").strip() for item in bullets if str(item or "").strip()]
        if not cleaned:
            return path

        date_text = path.stem
        if not path.exists():
            path.write_text(f"# {date_text}\n\n", encoding="utf-8")

        with path.open("a", encoding="utf-8") as handle:
            for bullet in cleaned:
                handle.write(f"- {bullet}\n")
        return path

    def entity_dir(self, entity_type: str, entity_id: str) -> Path:
        slug_type = _slug(entity_type)
        slug_id = _slug(entity_id)
        if not slug_type or not slug_id:
            raise ValueError("entity_type and entity_id must be non-empty")
        return self.entities_dir / slug_type / slug_id

    def entity_items_path(self, entity_type: str, entity_id: str) -> Path:
        return self.entity_dir(entity_type, entity_id) / "items.md"

    def entity_summary_path(self, entity_type: str, entity_id: str) -> Path:
        return self.entity_dir(entity_type, entity_id) / "summary.md"

    def entity_aliases_path(self, entity_type: str, entity_id: str) -> Path:
        return self.entity_dir(entity_type, entity_id) / "aliases.md"

    def entity_relations_path(self, entity_type: str, entity_id: str) -> Path:
        return self.entity_dir(entity_type, entity_id) / "relations.md"

    def append_entity_fact(
        self,
        *,
        entity_type: str,
        entity_id: str,
        fact: str,
        kind: str = "fact",
        fact_date: str | date | None = None,
        confidence: float | None = None,
        source: str | None = None,
        supersedes: str | None = None,
    ) -> EntityFactWriteResult:
        self.ensure_layout()
        slug_type = _slug(entity_type)
        slug_id = _slug(entity_id)
        text = str(fact or "").strip()
        if not slug_type or not slug_id or not text:
            raise ValueError("entity_type, entity_id, and fact must be non-empty")

        if fact_date is None:
            date_text = _current_date()
        elif isinstance(fact_date, date):
            date_text = fact_date.isoformat()
        else:
            date_text = str(fact_date).strip() or _current_date()

        entity_dir = self.entity_dir(slug_type, slug_id)
        entity_dir.mkdir(parents=True, exist_ok=True)
        items_path = entity_dir / "items.md"
        if not items_path.exists():
            items_path.write_text("# Atomic Facts (append-only)\n\n", encoding="utf-8")

        existing = items_path.read_text(encoding="utf-8")
        if text in existing:
            return EntityFactWriteResult(
                path=items_path,
                entity_type=slug_type,
                entity_id=slug_id,
                fact_id=None,
                created=False,
            )

        fact_id = _next_fact_id(existing, entity_type=slug_type, entity_id=slug_id)
        metadata = f"- [id:{fact_id}] [ts:{date_text}] [kind:{_slug(kind) or 'fact'}]"
        if confidence is not None:
            metadata += f" [conf:{float(confidence):.2f}]"
        if source:
            metadata += f"\n  [source:{str(source).strip()}]"
        if supersedes:
            metadata += f" [supersedes:{str(supersedes).strip()}]"
        block = f"{metadata}\n  {text}\n\n"

        with items_path.open("a", encoding="utf-8") as handle:
            handle.write(_ensure_trailing_newline(block))

        return EntityFactWriteResult(
            path=items_path,
            entity_type=slug_type,
            entity_id=slug_id,
            fact_id=fact_id,
            created=True,
        )

    def append_entity_alias(
        self,
        *,
        entity_type: str,
        entity_id: str,
        alias: str,
    ) -> EntityAliasWriteResult:
        self.ensure_layout()
        slug_type = _slug(entity_type)
        slug_id = _slug(entity_id)
        alias_text = str(alias or "").strip()
        alias_key = _normalize_alias(alias_text)
        if not slug_type or not slug_id or not alias_text or not alias_key:
            raise ValueError("entity_type, entity_id, and alias must be non-empty")

        entity_dir = self.entity_dir(slug_type, slug_id)
        entity_dir.mkdir(parents=True, exist_ok=True)
        aliases_path = entity_dir / "aliases.md"
        if not aliases_path.exists():
            aliases_path.write_text("# Aliases\n\n", encoding="utf-8")

        existing = aliases_path.read_text(encoding="utf-8")
        for line in existing.splitlines():
            stripped = line.strip()
            if not stripped.startswith("- "):
                continue
            if _normalize_alias(stripped[2:]) == alias_key:
                return EntityAliasWriteResult(
                    path=aliases_path,
                    entity_type=slug_type,
                    entity_id=slug_id,
                    alias=alias_text,
                    created=False,
                )

        with aliases_path.open("a", encoding="utf-8") as handle:
            handle.write(f"- {alias_text}\n")

        return EntityAliasWriteResult(
            path=aliases_path,
            entity_type=slug_type,
            entity_id=slug_id,
            alias=alias_text,
            created=True,
        )

    def append_entity_relation(
        self,
        *,
        from_entity_type: str,
        from_entity_id: str,
        relation_type: str,
        to_entity_type: str,
        to_entity_id: str,
        statement: str,
        relation_date: str | date | None = None,
        confidence: float | None = None,
        source: str | None = None,
        supersedes: str | None = None,
    ) -> EntityRelationWriteResult:
        self.ensure_layout()
        from_type = _slug(from_entity_type)
        from_id = _slug(from_entity_id)
        relation_slug = _slug(relation_type)
        to_type = _slug(to_entity_type)
        to_id = _slug(to_entity_id)
        text = str(statement or "").strip()
        if not from_type or not from_id or not relation_slug or not to_type or not to_id or not text:
            raise ValueError("relation endpoints, relation_type, and statement must be non-empty")

        if relation_date is None:
            date_text = _current_date()
        elif isinstance(relation_date, date):
            date_text = relation_date.isoformat()
        else:
            date_text = str(relation_date).strip() or _current_date()

        entity_dir = self.entity_dir(from_type, from_id)
        entity_dir.mkdir(parents=True, exist_ok=True)
        relations_path = entity_dir / "relations.md"
        if not relations_path.exists():
            relations_path.write_text("# Relationships (append-only)\n\n", encoding="utf-8")

        existing = relations_path.read_text(encoding="utf-8")
        to_ref = f"{to_type}/{to_id}"
        dedupe_key = f"[rel:{relation_slug}] [to:{to_ref}]"
        normalized_text = re.sub(r"\s+", " ", text)
        if dedupe_key in existing and normalized_text in re.sub(r"\s+", " ", existing):
            return EntityRelationWriteResult(
                path=relations_path,
                from_entity_type=from_type,
                from_entity_id=from_id,
                relation_id=None,
                relation_type=relation_slug,
                to_ref=to_ref,
                created=False,
            )

        relation_id = _next_relation_id(existing, entity_type=from_type, entity_id=from_id)
        metadata = (
            f"- [id:{relation_id}] [ts:{date_text}] [rel:{relation_slug}] [to:{to_ref}]"
        )
        if confidence is not None:
            metadata += f" [conf:{float(confidence):.2f}]"
        if supersedes:
            metadata += f" [supersedes:{str(supersedes).strip()}]"
        block = metadata
        if source:
            block += f"\n  [source:{str(source).strip()}]"
        block += f"\n  {text}\n\n"

        with relations_path.open("a", encoding="utf-8") as handle:
            handle.write(_ensure_trailing_newline(block))

        return EntityRelationWriteResult(
            path=relations_path,
            from_entity_type=from_type,
            from_entity_id=from_id,
            relation_id=relation_id,
            relation_type=relation_slug,
            to_ref=to_ref,
            created=True,
        )

    def write_entity_summary(self, *, entity_type: str, entity_id: str, summary: str) -> Path:
        self.ensure_layout()
        text = str(summary or "").strip()
        if not text:
            raise ValueError("summary must be non-empty")
        entity_dir = self.entity_dir(entity_type, entity_id)
        entity_dir.mkdir(parents=True, exist_ok=True)
        path = entity_dir / "summary.md"
        path.write_text(_ensure_trailing_newline(text), encoding="utf-8")
        return path
