from __future__ import annotations

from pathlib import Path

from drost.entity_resolution import EntityResolver
from drost.memory_files import MemoryFiles


def test_entity_resolver_prefers_aliases_on_disk(tmp_path: Path) -> None:
    memory = MemoryFiles(tmp_path)
    memory.append_entity_alias(entity_type="projects", entity_id="drost", alias="the repo")

    resolver = EntityResolver(tmp_path)
    resolved = resolver.resolve(entity_type="projects", entity_name="the repo")

    assert resolved is not None
    assert resolved.entity_type == "projects"
    assert resolved.entity_id == "drost"


def test_entity_resolver_registers_new_aliases_in_memory(tmp_path: Path) -> None:
    resolver = EntityResolver(tmp_path)

    resolved = resolver.resolve(entity_type="projects", entity_name="Drost")
    assert resolved is not None
    resolver.register_alias(resolved, "/Users/migel/drost")

    again = resolver.resolve(entity_type="projects", entity_name="/Users/migel/drost")
    assert again is not None
    assert again.entity_type == "projects"
    assert again.entity_id == "drost"
