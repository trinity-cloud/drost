from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.context_budget import truncate_text_to_budget

TOOL_EXECUTION_CONTRACT = """[Tool Execution Contract]
- If tools are available and the task requires an external action or retrieval, call tool(s) in this turn.
- Do not claim you searched, fetched, read, wrote, executed, or verified anything unless you actually called a tool.
- Do not promise future tool actions ("I'll do X now") and then end the turn without a tool call.
- When a tool returns an error, report the error clearly and either retry with corrected parameters or ask for the next instruction."""


class PromptAssembler:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _read_workspace_blocks(self) -> list[tuple[str, str]]:
        blocks: list[tuple[str, str]] = []
        root = Path(self._settings.workspace_dir).expanduser()
        for name in self._settings.prompt_workspace_files:
            rel = str(name or "").strip()
            if not rel:
                continue
            path = root / rel
            if not path.exists() or not path.is_file():
                continue
            body = path.read_text(encoding="utf-8", errors="replace").strip()
            if not body:
                continue
            blocks.append((rel, body))
        return blocks

    def assemble(
        self,
        *,
        base_prompt: str,
        memory_block: str = "",
        history_summary: str = "",
        provider_name: str = "",
        tool_names: list[str] | None = None,
    ) -> str:
        sections: list[str] = [str(base_prompt or "").strip()]

        for name, body in self._read_workspace_blocks():
            sections.append(f"[Workspace: {name}]\n{body}")

        if history_summary.strip():
            sections.append(f"[Conversation Summary]\n{history_summary.strip()}")

        if memory_block.strip():
            sections.append(memory_block.strip())

        hints: list[str] = []
        if provider_name:
            hints.append(f"provider={provider_name}")
        if tool_names:
            sections.append(TOOL_EXECUTION_CONTRACT)
            hints.append(f"tools={', '.join(tool_names)}")
        if hints:
            sections.append("[Run Hints]\n" + "\n".join(hints))

        merged = "\n\n".join(section for section in sections if section)
        return truncate_text_to_budget(merged, self._settings.context_budget_system_tokens)
