from __future__ import annotations

from pathlib import Path

from drost.config import Settings


def _build_settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        workspace_dir=tmp_path / "workspace",
        trace_enabled=False,
        sqlite_path=tmp_path / "drost.sqlite3",
    )


def test_workspace_bootstrap_seeds_default_prompt_files(tmp_path: Path) -> None:
    settings = _build_settings(tmp_path)
    workspace = settings.workspace_dir

    for name in ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md", "BOOTSTRAP.md"]:
        file_path = workspace / name
        assert file_path.exists()
        text = file_path.read_text(encoding="utf-8")
        assert text.strip()

    assert (workspace / "memory" / "daily").exists()
    assert (workspace / "memory" / "entities").exists()


def test_workspace_bootstrap_does_not_overwrite_existing_files(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    soul = workspace / "SOUL.md"
    soul.write_text("custom soul content\n", encoding="utf-8")

    settings = _build_settings(tmp_path)
    assert settings.workspace_dir == workspace
    assert soul.read_text(encoding="utf-8") == "custom soul content\n"

    # Other missing seed files should still be created.
    assert (workspace / "AGENTS.md").exists()
    assert (workspace / "IDENTITY.md").exists()
    assert (workspace / "USER.md").exists()
    assert (workspace / "TOOLS.md").exists()
    assert (workspace / "HEARTBEAT.md").exists()
    assert (workspace / "MEMORY.md").exists()
    assert not (workspace / "BOOTSTRAP.md").exists()
