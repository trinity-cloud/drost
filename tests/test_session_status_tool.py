from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.tools.session_status import SessionStatusTool


class _DummyStore:
    def get_active_session_id(self, chat_id: int) -> str | None:
        _ = chat_id
        return "s_main"

    def message_count(self, session_key: str) -> int:
        _ = session_key
        return 12

    def list_chat_sessions(self, chat_id: int) -> list[dict[str, object]]:
        _ = chat_id
        return [
            {"session_id": "s_main", "title": "Main", "message_count": 12},
            {"session_id": "s_other", "title": "Other", "message_count": 4},
        ]


async def test_session_status_tool_includes_runtime_topology(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    settings = Settings(
        workspace_dir=workspace_dir,
        repo_root=repo_root,
        gateway_port=9999,
        runtime_launch_mode="subprocess",
        runtime_start_command="uv run drost",
    )
    tool = SessionStatusTool(
        settings=settings,
        store=_DummyStore(),  # type: ignore[arg-type]
        current_chat_id=lambda: 123,
        current_session_key=lambda: "main:telegram:123__s_main",
    )

    text = await tool.execute()

    assert "chat_id=123" in text
    assert "active_session_id=s_main" in text
    assert f"repo_root={settings.repo_root}" in text
    assert f"workspace_root={settings.workspace_dir}" in text
    assert "gateway_health_url=http://127.0.0.1:9999/health" in text
    assert "launch_mode=subprocess" in text
    assert "start_command=uv run drost" in text
