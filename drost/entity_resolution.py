from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from drost.memory_files import MemoryFiles, normalize_alias_value, slugify_memory_key


@dataclass(slots=True, frozen=True)
class ResolvedEntity:
    entity_type: str
    entity_id: str


class EntityResolver:
    def __init__(self, workspace_dir: str | Path) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._memory_files = MemoryFiles(self._workspace_dir)
        self._aliases: dict[tuple[str, str], ResolvedEntity] = {}
        self._entities: set[tuple[str, str]] = set()
        self._load_from_disk()

    def resolve(self, *, entity_type: str, entity_name: str) -> ResolvedEntity | None:
        slug_type = slugify_memory_key(entity_type)
        raw_name = str(entity_name or "").strip()
        if not slug_type or not raw_name:
            return None

        alias_key = normalize_alias_value(raw_name)
        existing = self._aliases.get((slug_type, alias_key))
        if existing is not None:
            return existing

        slug_id = slugify_memory_key(raw_name)
        if not slug_id:
            return None

        resolved = ResolvedEntity(entity_type=slug_type, entity_id=slug_id)
        self._entities.add((resolved.entity_type, resolved.entity_id))
        self._aliases[(slug_type, alias_key)] = resolved
        return resolved

    def register_alias(self, entity: ResolvedEntity, alias: str) -> None:
        alias_key = normalize_alias_value(alias)
        if not alias_key:
            return
        self._aliases[(entity.entity_type, alias_key)] = entity
        self._entities.add((entity.entity_type, entity.entity_id))

    def _load_from_disk(self) -> None:
        entities_root = self._workspace_dir / "memory" / "entities"
        if not entities_root.exists():
            return

        for entity_dir in sorted(path for path in entities_root.glob("*/*") if path.is_dir()):
            entity_type = slugify_memory_key(entity_dir.parent.name)
            entity_id = slugify_memory_key(entity_dir.name)
            if not entity_type or not entity_id:
                continue
            resolved = ResolvedEntity(entity_type=entity_type, entity_id=entity_id)
            self._entities.add((entity_type, entity_id))
            self._aliases[(entity_type, normalize_alias_value(entity_id))] = resolved

            aliases_path = entity_dir / "aliases.md"
            if not aliases_path.exists():
                continue
            try:
                text = aliases_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped.startswith("- "):
                    continue
                alias = stripped[2:].strip()
                if not alias:
                    continue
                self._aliases[(entity_type, normalize_alias_value(alias))] = resolved
