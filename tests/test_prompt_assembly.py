from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.prompt_assembly import PromptAssembler


def test_prompt_assembly_includes_workspace_files(tmp_path: Path) -> None:
    (tmp_path / "SOUL.md").write_text("Soul content", encoding="utf-8")
    (tmp_path / "USER.md").write_text("User preferences", encoding="utf-8")

    settings = Settings(
        workspace_dir=tmp_path,
        prompt_workspace_files=["SOUL.md", "USER.md"],
        context_budget_system_tokens=8_000,
    )
    assembler = PromptAssembler(settings)
    prompt = assembler.assemble(
        base_prompt="Base prompt",
        memory_block="Memory block",
        history_summary="Summary block",
        provider_name="openai-codex",
        tool_names=["file_read", "web_search"],
    )

    assert "Base prompt" in prompt
    assert "Soul content" in prompt
    assert "User preferences" in prompt
    assert "Summary block" in prompt
    assert "Memory block" in prompt
    assert "openai-codex" in prompt
    assert "file_read" in prompt
    assert "[Tool Execution Contract]" in prompt
    assert "Do not claim you searched" in prompt
