from __future__ import annotations

from collections.abc import Callable

from drost.config import Settings
from drost.storage import SQLiteStore, session_key_for_telegram_chat
from drost.tools.base import BaseTool


class SessionStatusTool(BaseTool):
    def __init__(
        self,
        *,
        settings: Settings,
        store: SQLiteStore,
        current_chat_id: Callable[[], int],
        current_session_key: Callable[[], str],
    ) -> None:
        self._settings = settings
        self._store = store
        self._current_chat_id = current_chat_id
        self._current_session_key = current_session_key

    @property
    def name(self) -> str:
        return "session_status"

    @property
    def description(self) -> str:
        return "Inspect active session, runtime topology, and recent sessions for a Telegram chat."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "chat_id": {"type": "integer", "description": "Telegram chat id. Defaults to current chat."},
            },
            "required": [],
        }

    async def execute(self, *, chat_id: int | None = None) -> str:
        resolved_chat_id = int(chat_id) if chat_id is not None else int(self._current_chat_id())
        if resolved_chat_id <= 0:
            return "Error: chat_id is not available in this context"

        active = self._store.get_active_session_id(resolved_chat_id) or "legacy-main"
        active_key = (
            self._current_session_key()
            if chat_id is None
            else session_key_for_telegram_chat(resolved_chat_id, None if active == "legacy-main" else active)
        )
        count = self._store.message_count(active_key)
        sessions = self._store.list_chat_sessions(resolved_chat_id)

        lines: list[str] = [
            f"chat_id={resolved_chat_id}",
            f"active_session_id={active}",
            f"active_session_key={active_key}",
            f"active_message_count={count}",
            f"repo_root={self._settings.repo_root}",
            f"workspace_root={self._settings.workspace_dir}",
            f"gateway_health_url={self._settings.gateway_health_url}",
            f"launch_mode={self._settings.runtime_launch_mode}",
            f"start_command={self._settings.runtime_start_command}",
            "recent_sessions:",
        ]
        for idx, row in enumerate(sessions[:10], start=1):
            lines.append(
                f"{idx}. session_id={str(row.get('session_id') or '')} "
                f"title={str(row.get('title') or '').strip() or '-'} "
                f"messages={int(row.get('message_count') or 0)}"
            )
        return "\n".join(lines)
