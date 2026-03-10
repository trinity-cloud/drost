from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from drost.followups import FollowUpStore
from drost.tools.base import BaseTool


class FollowUpUpdateTool(BaseTool):
    def __init__(self, *, followups: FollowUpStore, current_chat_id: Callable[[], int]) -> None:
        self._followups = followups
        self._current_chat_id = current_chat_id

    @property
    def name(self) -> str:
        return "followup_update"

    @property
    def description(self) -> str:
        return "Complete, dismiss, or snooze a follow-up item for the current chat."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "followup_id": {"type": "string", "description": "Follow-up id to update."},
                "action": {
                    "type": "string",
                    "enum": ["complete", "dismiss", "snooze"],
                    "description": "Update action.",
                },
                "until": {
                    "type": "string",
                    "description": "Required for snooze. ISO-8601 UTC timestamp until which the item should be suppressed.",
                },
            },
            "required": ["followup_id", "action"],
        }

    async def execute(self, *, followup_id: str, action: str, until: str | None = None) -> str:
        chat_id = int(self._current_chat_id() or 0)
        if chat_id <= 0:
            return "Error: no active chat context"
        item = self._find_followup(chat_id=chat_id, followup_id=followup_id)
        if item is None:
            return f"Error: follow-up not found: {followup_id}"

        cleaned_action = str(action or "").strip().lower()
        if cleaned_action == "complete":
            updated = self._followups.mark_completed(str(item.get("id") or ""))
        elif cleaned_action == "dismiss":
            updated = self._followups.dismiss(str(item.get("id") or ""))
        elif cleaned_action == "snooze":
            target = self._parse_time(until)
            if target is None:
                return "Error: until is required for snooze and must be a valid ISO-8601 UTC timestamp"
            updated = self._followups.snooze(str(item.get("id") or ""), until=target)
        else:
            return f"Error: unsupported action: {action}"

        if updated is None:
            return f"Error: failed to update follow-up: {followup_id}"
        return (
            f"followup_updated=true\n"
            f"id={updated.get('id','')}\n"
            f"status={updated.get('status','')}\n"
            f"subject={updated.get('subject','')}\n"
            f"due_at={updated.get('due_at','')}"
        )

    def _find_followup(self, *, chat_id: int, followup_id: str) -> dict[str, object] | None:
        cleaned = str(followup_id or "").strip()
        if not cleaned:
            return None
        for row in self._followups.list_followups(chat_id=chat_id):
            if str(row.get("id") or "") == cleaned:
                return row
        return None

    @staticmethod
    def _parse_time(value: str | None) -> datetime | None:
        cleaned = str(value or "").strip()
        if not cleaned:
            return None
        try:
            if cleaned.endswith("Z"):
                return datetime.fromisoformat(cleaned.replace("Z", "+00:00")).astimezone(UTC)
            parsed = datetime.fromisoformat(cleaned)
            return parsed.astimezone(UTC) if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
        except Exception:
            return None
