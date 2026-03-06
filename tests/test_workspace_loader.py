from __future__ import annotations

from pathlib import Path

from drost.workspace_loader import WorkspaceLoader


def test_workspace_loader_loads_structured_context(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("Agents", encoding="utf-8")
    (tmp_path / "SOUL.md").write_text("---\ntitle: x\n---\nSoul", encoding="utf-8")
    (tmp_path / "IDENTITY.md").write_text("Agent Name: Echo", encoding="utf-8")
    (tmp_path / "USER.md").write_text("User", encoding="utf-8")
    (tmp_path / "TOOLS.md").write_text("Tools", encoding="utf-8")
    (tmp_path / "MEMORY.md").write_text("Memory", encoding="utf-8")
    daily = tmp_path / "memory" / "daily"
    daily.mkdir(parents=True, exist_ok=True)
    (daily / "2099-01-01.md").write_text("Daily", encoding="utf-8")
    (tmp_path / "EXTRA.md").write_text("Extra", encoding="utf-8")

    ctx = WorkspaceLoader(tmp_path).load(extra_files=["SOUL.md", "EXTRA.md"])

    assert ctx.agents_md == "Agents"
    assert ctx.soul_md == "Soul"
    assert ctx.identity_md == "Agent Name: Echo"
    assert ctx.tools_md == "Tools"
    assert ctx.memory_md == "Memory"
    assert ctx.agent_name == "Echo"
    assert ctx.extra_files == [("EXTRA.md", "Extra")]


def test_workspace_loader_tracks_bootstrap_completion_marker(tmp_path: Path) -> None:
    (tmp_path / "BOOTSTRAP.md").write_text("Bootstrap", encoding="utf-8")
    ctx = WorkspaceLoader(tmp_path).load()
    assert ctx.bootstrap_active is True

    (tmp_path / ".bootstrap-complete").write_text("done", encoding="utf-8")
    completed = WorkspaceLoader(tmp_path).load()
    assert completed.bootstrap_active is False
