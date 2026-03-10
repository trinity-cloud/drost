from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from drost.loop_events import EventSubscription, LoopEventBus
from drost.managed_loop import LoopLifecycleState, LoopPriority, LoopVisibility, ManagedLoop


class ConversationLoop(ManagedLoop):
    def __init__(self, *, event_bus: LoopEventBus) -> None:
        self._event_bus = event_bus
        self._subscription: EventSubscription | None = None
        self._listener_task: asyncio.Task[None] | None = None
        self._running = False
        self._state = LoopLifecycleState.REGISTERED
        self._in_flight_turns = 0
        self._last_error = ""
        self._last_failure_at = ""
        self._last_event_type = ""
        self._last_user_message_at = ""
        self._last_assistant_turn_at = ""
        self._last_session_switch_at = ""
        self._last_chat_id = 0
        self._last_session_key = ""
        self._last_started_at = ""
        self._last_stopped_at = ""
        self._start_count = 0
        self._stop_count = 0
        self._failure_count = 0
        self._recovery_count = 0

    @property
    def name(self) -> str:
        return "conversation_loop"

    @property
    def priority(self) -> LoopPriority:
        return LoopPriority.FOREGROUND

    @property
    def visibility(self) -> LoopVisibility:
        return LoopVisibility.FOREGROUND

    async def start(self) -> None:
        if self._running:
            return
        prior_state = self._state
        self._running = True
        self._subscription = self._event_bus.subscribe(
            name=self.name,
            event_types={
                "user_message_received",
                "assistant_turn_completed",
                "session_switched",
            },
        )
        self._listener_task = asyncio.create_task(self._listen())
        if prior_state == LoopLifecycleState.FAILED:
            self._recovery_count += 1
        self._state = LoopLifecycleState.RUNNING
        self._last_started_at = self._utc_now()
        self._start_count += 1
        self._last_error = ""

    async def stop(self) -> None:
        self._running = False
        if self._listener_task is not None:
            self._listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._listener_task
            self._listener_task = None
        if self._subscription is not None:
            self._event_bus.unsubscribe(self._subscription.name)
            self._subscription = None
        self._state = LoopLifecycleState.STOPPED
        self._last_stopped_at = self._utc_now()
        self._stop_count += 1

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "priority": int(self.priority),
            "visibility": str(self.visibility),
            "state": str(self._state),
            "running": self._running,
            "in_flight_turns": int(self._in_flight_turns),
            "last_event_type": self._last_event_type,
            "last_user_message_at": self._last_user_message_at,
            "last_assistant_turn_at": self._last_assistant_turn_at,
            "last_session_switch_at": self._last_session_switch_at,
            "last_chat_id": int(self._last_chat_id),
            "last_session_key": self._last_session_key,
            "last_error": self._last_error,
            "last_failure_at": self._last_failure_at,
            "last_started_at": self._last_started_at,
            "last_stopped_at": self._last_stopped_at,
            "start_count": self._start_count,
            "stop_count": self._stop_count,
            "failure_count": self._failure_count,
            "recovery_count": self._recovery_count,
        }

    async def _listen(self) -> None:
        subscription = self._subscription
        if subscription is None:
            return
        while self._running and subscription.active:
            try:
                event = await subscription.get()
            except asyncio.CancelledError:
                break
            try:
                self._apply_event(event.as_dict())
            except Exception as exc:
                self._state = LoopLifecycleState.FAILED
                self._last_error = str(exc)
                self._last_failure_at = self._utc_now()
                self._failure_count += 1

    def _apply_event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type") or "").strip()
        timestamp = str(event.get("timestamp") or "")
        scope = event.get("scope")
        scope_dict = scope if isinstance(scope, dict) else {}
        self._last_event_type = event_type
        self._last_chat_id = int(scope_dict.get("chat_id") or 0)
        self._last_session_key = str(scope_dict.get("session_key") or "")

        if event_type == "user_message_received":
            self._in_flight_turns += 1
            self._last_user_message_at = timestamp
            return

        if event_type == "assistant_turn_completed":
            self._in_flight_turns = max(0, self._in_flight_turns - 1)
            self._last_assistant_turn_at = timestamp
            return

        if event_type == "session_switched":
            self._last_session_switch_at = timestamp

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()
