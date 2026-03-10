from __future__ import annotations

from collections.abc import Callable

from drost.followups import FollowUpStore
from drost.tools.base import BaseTool


class FollowUpStatusTool(BaseTool):
    def __init__(self, *, followups: FollowUpStore, current_chat_id: Callable[[], int]) -> None:
        self._followups = followups
        self._current_chat_id = current_chat_id

    @property
    def name(self) -> str:
        return "followup_status"

    @property
    def description(self) -> str:
        return "List outstanding follow-ups for the current chat, including ids, due times, and statuses."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Maximum number of follow-ups to list.", "minimum": 1},
                "due_only": {"type": "boolean", "description": "If true, only show due follow-ups."},
            },
            "required": [],
        }

    async def execute(self, *, limit: int | None = None, due_only: bool | None = None) -> str:
        chat_id = int(self._current_chat_id() or 0)
        if chat_id <= 0:
            return "No active chat context."
        max_items = max(1, min(int(limit or 8), 20))
        rows = (
            self._followups.list_due(chat_id=chat_id, limit=max_items)
            if bool(due_only)
            else self._followups.list_followups(chat_id=chat_id)[:max_items]
        )
        if not rows:
            return "No follow-ups found."

        lines = [f"Follow-ups for chat_id={chat_id}"]
        for idx, row in enumerate(rows, start=1):
            lines.append(
                f"{idx}. id={row.get('id','')} status={row.get('status','')} priority={row.get('priority','')} due_at={row.get('due_at','')}"
            )
            subject = str(row.get("subject") or "").strip()
            prompt = str(row.get("follow_up_prompt") or "").strip()
            if subject:
                lines.append(f"   subject={subject}")
            if prompt:
                lines.append(f"   prompt={prompt}")
        return "\n".join(lines)
