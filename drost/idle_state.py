from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from drost.shared_mind_state import SharedMindState


class IdleStateStore:
    def __init__(
        self,
        workspace_dir: str | Path | None = None,
        *,
        shared_mind_state: SharedMindState | None = None,
    ) -> None:
        if shared_mind_state is None and workspace_dir is None:
            raise ValueError("workspace_dir or shared_mind_state is required")
        self._shared = shared_mind_state or SharedMindState(workspace_dir or ".")

    @property
    def path(self) -> Path:
        return self._shared.path

    @property
    def shared_mind_state(self) -> SharedMindState:
        return self._shared

    def ensure(self) -> None:
        _ = self._shared.snapshot()

    def load(self) -> dict[str, Any]:
        return self._shared.to_idle_view(active_window_seconds=20 * 60)

    def save(self, payload: dict[str, Any]) -> None:
        self._shared.overwrite_from_idle_payload(payload)

    def mark_user_message(
        self,
        *,
        chat_id: int,
        at: datetime | None = None,
        session_key: str | None = None,
        channel: str = "telegram",
    ) -> dict[str, Any]:
        self._shared.mark_user_message(
            chat_id=chat_id,
            session_key=session_key,
            channel=channel,
            at=at,
        )
        return self._shared.to_idle_view(active_window_seconds=20 * 60, now=at)

    def mark_assistant_message(
        self,
        *,
        chat_id: int,
        at: datetime | None = None,
        session_key: str | None = None,
        channel: str = "telegram",
    ) -> dict[str, Any]:
        self._shared.mark_assistant_message(
            chat_id=chat_id,
            session_key=session_key,
            channel=channel,
            at=at,
        )
        return self._shared.to_idle_view(active_window_seconds=20 * 60, now=at)

    def note_heartbeat(self, *, at: datetime | None = None) -> dict[str, Any]:
        self._shared.note_heartbeat(at=at)
        return self._shared.to_idle_view(active_window_seconds=20 * 60, now=at)

    def note_heartbeat_decision(
        self,
        *,
        decision: str,
        reason: str = "",
        follow_up_id: str = "",
        audit_id: str = "",
        trigger_reason: str = "",
        decision_class: str = "",
        importance: str = "",
        meaningful: bool = True,
        aggregate_counter: str = "",
        at: datetime | None = None,
    ) -> dict[str, Any]:
        return self._shared.note_heartbeat_decision(
            decision=decision,
            reason=reason,
            follow_up_id=follow_up_id,
            audit_id=audit_id,
            trigger_reason=trigger_reason,
            decision_class=decision_class,
            importance=importance,
            meaningful=meaningful,
            aggregate_counter=aggregate_counter,
            at=at,
        )

    def note_proactive_surface(
        self,
        *,
        chat_id: int,
        at: datetime | None = None,
        session_key: str | None = None,
        channel: str = "telegram",
        cooldown_seconds: int = 6 * 60 * 60,
    ) -> dict[str, Any]:
        self._shared.note_proactive_surface(
            chat_id=chat_id,
            session_key=session_key,
            channel=channel,
            at=at,
            cooldown_seconds=cooldown_seconds,
        )
        return self._shared.to_idle_view(active_window_seconds=20 * 60, now=at)

    def refresh(self, *, active_window_seconds: int, now: datetime | None = None) -> dict[str, Any]:
        self._shared.refresh_mode(active_window_seconds=active_window_seconds, now=now)
        return self._shared.to_idle_view(active_window_seconds=active_window_seconds, now=now)

    def status(self, *, active_window_seconds: int) -> dict[str, Any]:
        return self._shared.to_idle_view(active_window_seconds=active_window_seconds)
