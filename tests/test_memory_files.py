from __future__ import annotations

from pathlib import Path

from drost.memory_files import MemoryFiles


def test_memory_files_append_daily_bullets(tmp_path: Path) -> None:
    memory = MemoryFiles(tmp_path)

    path = memory.append_daily_bullets(
        ["Confirmed memory files are canonical.", "Added a second note."],
        day="2026-03-06",
    )

    assert path == tmp_path / "memory" / "daily" / "2026-03-06.md"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# 2026-03-06")
    assert "- Confirmed memory files are canonical." in text
    assert "- Added a second note." in text
    assert (tmp_path / "state").exists()


def test_memory_files_append_entity_fact_dedupes_exact_text(tmp_path: Path) -> None:
    memory = MemoryFiles(tmp_path)

    first = memory.append_entity_fact(
        entity_type="projects",
        entity_id="Drost",
        fact="Drost stores durable memory in Markdown files.",
        kind="decision",
        fact_date="2026-03-06",
    )
    second = memory.append_entity_fact(
        entity_type="projects",
        entity_id="Drost",
        fact="Drost stores durable memory in Markdown files.",
        kind="decision",
        fact_date="2026-03-06",
    )

    text = first.path.read_text(encoding="utf-8")
    assert first.created is True
    assert first.fact_id == "projects/drost/0001"
    assert second.created is False
    assert text.count("Drost stores durable memory in Markdown files.") == 1


def test_memory_files_append_entity_alias_dedupes_normalized_alias(tmp_path: Path) -> None:
    memory = MemoryFiles(tmp_path)

    first = memory.append_entity_alias(
        entity_type="projects",
        entity_id="Drost",
        alias="Drost",
    )
    second = memory.append_entity_alias(
        entity_type="projects",
        entity_id="Drost",
        alias="  drost  ",
    )

    text = first.path.read_text(encoding="utf-8")
    assert first.created is True
    assert second.created is False
    assert first.path == tmp_path / "memory" / "entities" / "projects" / "drost" / "aliases.md"
    assert text.startswith("# Aliases")
    assert text.count("- Drost") == 1


def test_memory_files_append_entity_relation_writes_metadata_and_dedupes(tmp_path: Path) -> None:
    memory = MemoryFiles(tmp_path)

    first = memory.append_entity_relation(
        from_entity_type="projects",
        from_entity_id="Drost",
        relation_type="owned_by",
        to_entity_type="people",
        to_entity_id="Migel",
        statement="Drost is owned and directed by Migel.",
        relation_date="2026-03-09",
        confidence=0.99,
    )
    second = memory.append_entity_relation(
        from_entity_type="projects",
        from_entity_id="Drost",
        relation_type="owned_by",
        to_entity_type="people",
        to_entity_id="Migel",
        statement="Drost is owned and directed by Migel.",
        relation_date="2026-03-09",
        confidence=0.99,
    )
    third = memory.append_entity_relation(
        from_entity_type="projects",
        from_entity_id="Drost",
        relation_type="deploys_with",
        to_entity_type="tools",
        to_entity_id="Deployer",
        statement="Drost deploys through the deployer control plane.",
        relation_date="2026-03-09",
    )

    text = first.path.read_text(encoding="utf-8")
    assert first.created is True
    assert first.relation_id == "projects/drost/relations/0001"
    assert second.created is False
    assert third.created is True
    assert third.relation_id == "projects/drost/relations/0002"
    assert first.path == tmp_path / "memory" / "entities" / "projects" / "drost" / "relations.md"
    assert "# Relationships (append-only)" in text
    assert "[rel:owned_by] [to:people/migel] [conf:0.99]" in text
    assert "[rel:deploys_with] [to:tools/deployer]" in text
    assert text.count("Drost is owned and directed by Migel.") == 1
