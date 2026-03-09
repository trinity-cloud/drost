from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.prompt_assembly import PromptAssembler


def test_prompt_assembly_includes_structured_workspace_files(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("Agents contract", encoding="utf-8")
    (tmp_path / "SOUL.md").write_text("Soul content", encoding="utf-8")
    (tmp_path / "USER.md").write_text("User preferences", encoding="utf-8")
    memory_dir = tmp_path / "memory" / "daily"
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "2099-01-01.md").write_text("Future memory", encoding="utf-8")

    settings = Settings(
        workspace_dir=tmp_path,
        prompt_workspace_files=["SOUL.md", "USER.md", "EXTRA.md"],
        context_budget_system_tokens=8_000,
    )
    (tmp_path / "EXTRA.md").write_text("Extra workspace file", encoding="utf-8")
    assembler = PromptAssembler(settings)
    prompt = assembler.assemble(
        base_prompt="Base prompt",
        memory_block="Memory block",
        history_summary="Summary block",
        provider_name="openai-codex",
        tool_names=["file_read", "memory_search", "web_search"],
    )

    assert "Base prompt" in prompt
    assert "Agents contract" in prompt
    assert "Soul content" in prompt
    assert "User preferences" in prompt
    assert "Extra workspace file" in prompt
    assert "Summary block" in prompt
    assert "Memory block" in prompt
    assert "openai-codex" in prompt
    assert "file_read" in prompt
    assert "memory_search" in prompt
    assert "[Tool Execution Contract]" in prompt
    assert "Do not claim you searched" in prompt
    assert "[Tool Call Style]" in prompt
    assert "[Memory Recall]" in prompt
    assert "[Workspace Runtime]" in prompt


def test_prompt_assembly_includes_bootstrap_when_active(tmp_path: Path) -> None:
    (tmp_path / "BOOTSTRAP.md").write_text("Bootstrap body", encoding="utf-8")

    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_system_tokens=8_000,
    )
    prompt = PromptAssembler(settings).assemble(
        base_prompt="Base prompt",
        tool_names=["file_write"],
    )

    assert "Bootstrap body" in prompt
    assert "[Bootstrap Contract]" in prompt
    assert "bootstrap=active" in prompt


def test_prompt_assembly_includes_session_continuity(tmp_path: Path) -> None:
    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_system_tokens=8_000,
    )
    prompt = PromptAssembler(settings).assemble(
        base_prompt="Base prompt",
        continuity_summary="## Session Continuity\n### Open Threads\n- Finish the memory capsule.",
        tool_names=["memory_search"],
    )

    assert "[Session Continuity]" in prompt
    assert "Finish the memory capsule" in prompt


def test_prompt_assembly_omits_bootstrap_after_completion(tmp_path: Path) -> None:
    (tmp_path / "BOOTSTRAP.md").write_text("Bootstrap body", encoding="utf-8")
    (tmp_path / ".bootstrap-complete").write_text("done", encoding="utf-8")

    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_system_tokens=8_000,
    )
    prompt = PromptAssembler(settings).assemble(
        base_prompt="Base prompt",
        tool_names=["file_write"],
    )

    assert "Bootstrap body" not in prompt
    assert "[Bootstrap Contract]" not in prompt
