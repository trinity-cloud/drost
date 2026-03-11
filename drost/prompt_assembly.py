from __future__ import annotations

from datetime import datetime

from drost.config import Settings
from drost.context_budget import truncate_text_to_budget
from drost.workspace_loader import WorkspaceContext, WorkspaceLoader

TOOL_EXECUTION_CONTRACT = """[Tool Execution Contract]
- If tools are available and the task requires an external action or retrieval, call tool(s) in this turn.
- Do not claim you searched, fetched, read, wrote, executed, or verified anything unless you actually called a tool.
- Do not promise future tool actions ("I'll do X now") and then end the turn without a tool call.
- When a tool returns an error, report the error clearly and either retry with corrected parameters or ask for the next instruction."""

TOOL_STYLE_GUIDANCE = """[Tool Call Style]
- Default: silently perform routine, low-risk tool calls.
- Briefly narrate only when the work is multi-step, sensitive, or the user explicitly asked for status.
- Keep narration value-dense; do not restate obvious steps."""

MEMORY_RECALL_GUIDANCE = """[Memory Recall]
- For prior decisions, dates, people, projects, preferences, or ongoing work, inspect memory before answering from recall alone.
- Use memory_search to locate likely hits, then memory_get to inspect the exact source when needed.
- If memory is thin or uncertain, say so plainly."""

FOLLOW_UP_AWARENESS_GUIDANCE = """[Follow-Up Awareness]
- Treat due follow-ups below as operational context for this turn.
- If the user resolves one, acknowledge it and keep that resolution in mind.
- Do not force an unrelated follow-up into the reply unless it materially helps with the user's current request."""

FOLLOW_UP_CONTROL_GUIDANCE = """[Follow-Up Control]
- Use followup_status to inspect outstanding follow-ups for the current chat.
- Use followup_update to complete, dismiss, or snooze a follow-up when the user clearly resolves or postpones it.
- Prefer resolving a surfaced follow-up in the same turn instead of letting it linger."""

RUNTIME_TOPOLOGY_GUIDANCE = """[Runtime Topology]
- The runtime facts below are authoritative for this turn.
- Do not call tools just to rediscover repo root, workspace root, launch mode, or health URL unless you have reason to think they changed."""

DEPLOYER_CONTROL_GUIDANCE = """[Deployer Control]
- For runtime lifecycle actions such as restart, candidate deploy, rollback, or deployer inspection, use deployer_request and deployer_status.
- Do not improvise deploy control with shell_execute when the deployer tools are available."""

BOOTSTRAP_RUNTIME_CONTRACT = """[Bootstrap Contract]
- This workspace is still in bootstrap mode.
- Your near-term job is to establish a concrete agent identity and a concrete user profile.
- Keep it natural and brief. Do not dump the raw bootstrap procedure to the user.
- Gather enough information to materially fill IDENTITY.md and USER.md with real content, not placeholders.
- Use available tools to write those files.
- Once bootstrap is materially complete, create `.bootstrap-complete` in the workspace root with a short timestamped note."""


class PromptAssembler:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._workspace_loader = WorkspaceLoader(settings.workspace_dir)

    def assemble(
        self,
        *,
        base_prompt: str,
        memory_block: str = "",
        cognitive_block: str = "",
        follow_up_block: str = "",
        continuity_summary: str = "",
        history_summary: str = "",
        provider_name: str = "",
        tool_names: list[str] | None = None,
        include_heartbeat: bool = False,
    ) -> str:
        sections: list[str] = [str(base_prompt or "").strip()]
        tools = list(dict.fromkeys(tool_names or []))
        workspace = self._workspace_loader.load(
            extra_files=self._settings.prompt_workspace_files,
            include_memory_md=True,
            include_heartbeat=include_heartbeat,
        )

        if tools:
            sections.append(self._build_tooling_section(tools))
            sections.append(TOOL_STYLE_GUIDANCE)
            if "memory_search" in tools or "memory_get" in tools:
                sections.append(MEMORY_RECALL_GUIDANCE)
            if "deployer_request" in tools or "deployer_status" in tools:
                sections.append(DEPLOYER_CONTROL_GUIDANCE)
            if "followup_status" in tools or "followup_update" in tools:
                sections.append(FOLLOW_UP_CONTROL_GUIDANCE)

        sections.append(self._build_workspace_runtime_section())
        sections.extend(self._build_workspace_sections(workspace))
        sections.append(RUNTIME_TOPOLOGY_GUIDANCE)

        if continuity_summary.strip():
            sections.append(f"[Session Continuity]\n{continuity_summary.strip()}")

        if history_summary.strip():
            sections.append(f"[Conversation Summary]\n{history_summary.strip()}")

        if cognitive_block.strip():
            sections.append(cognitive_block.strip())

        if memory_block.strip():
            sections.append(memory_block.strip())
        if follow_up_block.strip():
            sections.append(FOLLOW_UP_AWARENESS_GUIDANCE)
            sections.append(follow_up_block.strip())

        hints: list[str] = []
        if provider_name:
            hints.append(f"provider={provider_name}")
        if tools:
            sections.append(TOOL_EXECUTION_CONTRACT)
            hints.append(f"tools={', '.join(tools)}")
        if workspace.bootstrap_active:
            sections.append(BOOTSTRAP_RUNTIME_CONTRACT)
            hints.append("bootstrap=active")
        if hints:
            sections.append("[Run Hints]\n" + "\n".join(hints))

        merged = "\n\n".join(section for section in sections if section)
        return truncate_text_to_budget(merged, self._settings.context_budget_system_tokens)

    @staticmethod
    def _build_tooling_section(tool_names: list[str]) -> str:
        lines = ["[Tooling]", "Available tools:"]
        for tool_name in tool_names:
            lines.append(f"- {tool_name}")
        return "\n".join(lines)

    def _build_workspace_runtime_section(self) -> str:
        now = datetime.now().astimezone()
        zone = now.tzname() or "local"
        return "\n".join(
            [
                "[Workspace Runtime]",
                f"repo_root={self._settings.repo_root}",
                f"workspace_root={self._settings.workspace_dir}",
                f"gateway_health_url={self._settings.gateway_health_url}",
                f"launch_mode={self._settings.runtime_launch_mode}",
                f"start_command={self._settings.runtime_start_command}",
                f"timezone={zone}",
                f"current_time={now.strftime('%Y-%m-%d %H:%M:%S %Z')}",
            ]
        )

    @staticmethod
    def _build_workspace_sections(workspace: WorkspaceContext) -> list[str]:
        ordered_files: list[tuple[str, str | None]] = [
            ("AGENTS.md", workspace.agents_md),
            ("BOOTSTRAP.md", workspace.bootstrap_md if workspace.bootstrap_active else None),
            ("SOUL.md", workspace.soul_md),
            ("TOOLS.md", workspace.tools_md),
            ("IDENTITY.md", workspace.identity_md),
            ("USER.md", workspace.user_md),
            ("MEMORY.md", workspace.memory_md),
            ("HEARTBEAT.md", workspace.heartbeat_md),
        ]
        sections: list[str] = []
        for name, body in ordered_files:
            if body:
                sections.append(f"[Workspace: {name}]\n{body}")
        for name, body in workspace.daily_memory:
            sections.append(f"[Workspace: {name}]\n{body}")
        for name, body in workspace.extra_files:
            sections.append(f"[Workspace: {name}]\n{body}")
        return sections
