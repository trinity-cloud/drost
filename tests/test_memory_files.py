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
