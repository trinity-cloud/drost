from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from drost.managed_loop import ManagedLoop
from drost.shared_mind_state import SharedMindState


class LoopManager:
    def __init__(
        self,
        *,
        shared_mind_state: SharedMindState | None = None,
        active_window_seconds: int = 20 * 60,
    ) -> None:
        self._loops: dict[str, ManagedLoop] = {}
        self._shared_mind_state = shared_mind_state
        self._active_window_seconds = max(60, int(active_window_seconds))
        self._running = False
        self._lock = asyncio.Lock()
        self._last_error = ""
        self._last_started_at = ""
        self._last_stopped_at = ""
        self._degraded = False
        self._degraded_reason = ""
        self._proactive_action_in_flight = False
        self._proactive_action_owner = ""
        self._last_proactive_action_at = ""
        self._last_proactive_action_reason = ""

    def register(self, loop: ManagedLoop) -> None:
        if loop.name in self._loops:
            raise ValueError(f"Loop '{loop.name}' is already registered")
        self._loops[loop.name] = loop

    def get(self, name: str) -> ManagedLoop:
        if name not in self._loops:
            raise KeyError(name)
        return self._loops[name]

    def names(self) -> list[str]:
        return [loop.name for loop in self._ordered_loops()]

    async def start(self) -> None:
        async with self._lock:
            if self._running:
                return
            try:
                for loop in self._ordered_loops():
                    await loop.start()
            except Exception as exc:
                self._last_error = str(exc)
                self.mark_degraded(str(exc))
                raise
            self._running = True
            self._last_started_at = self._utc_now()
            self._last_error = ""
            self.clear_degraded()

    async def stop(self) -> None:
        async with self._lock:
            errors: list[str] = []
            for loop in reversed(self._ordered_loops()):
                try:
                    await loop.stop()
                except Exception as exc:
                    errors.append(f"{loop.name}: {exc}")
            self._running = False
            self._last_stopped_at = self._utc_now()
            self._last_error = "; ".join(errors)
            if errors:
                self.mark_degraded(self._last_error)
                raise RuntimeError(self._last_error)

    def status(self) -> dict[str, Any]:
        loops = {loop.name: loop.status() for loop in self._ordered_loops()}
        states = [str(item.get("state") or "") for item in loops.values() if isinstance(item, dict)]
        loop_health = {
            "running": sum(1 for state in states if state == "running"),
            "failed": sum(1 for state in states if state == "failed"),
            "stopped": sum(1 for state in states if state == "stopped"),
            "registered": sum(1 for state in states if state == "registered"),
        }
        return {
            "running": self._running,
            "loop_count": len(self._loops),
            "loop_names": self.names(),
            "last_started_at": self._last_started_at,
            "last_stopped_at": self._last_stopped_at,
            "last_error": self._last_error,
            "degraded": self._degraded,
            "degraded_reason": self._degraded_reason,
            "proactive_action_in_flight": self._proactive_action_in_flight,
            "proactive_action_owner": self._proactive_action_owner,
            "last_proactive_action_at": self._last_proactive_action_at,
            "last_proactive_action_reason": self._last_proactive_action_reason,
            "loop_health": loop_health,
            "failed_loops": sorted(name for name, item in loops.items() if str(item.get("state") or "") == "failed"),
            "loops": loops,
        }

    def background_policy(self, loop_name: str) -> dict[str, Any]:
        cleaned_name = str(loop_name or "").strip()
        if self._degraded and cleaned_name == "heartbeat_loop":
            return {"allowed": False, "reason": "degraded_mode"}
        return {"allowed": True, "reason": "ok"}

    def proactive_gate(
        self,
        *,
        chat_id: int,
        session_key: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        if self._degraded:
            return {"allowed": False, "reason": "degraded_mode"}

        conversation = self.status()["loops"].get("conversation_loop", {})
        if int(conversation.get("in_flight_turns") or 0) > 0:
            return {"allowed": False, "reason": "conversation_in_flight"}

        if self._shared_mind_state is not None:
            shared = self._shared_mind_state.proactive_gate(
                active_window_seconds=self._active_window_seconds,
                chat_id=int(chat_id),
                session_key=session_key,
                now=now,
            )
            if not bool(shared.get("allowed")):
                return {
                    "allowed": False,
                    "reason": str(shared.get("reason") or "shared_state_blocked"),
                }

        if self._proactive_action_in_flight:
            return {"allowed": False, "reason": "proactive_in_flight"}

        return {"allowed": True, "reason": "ok"}

    def begin_proactive_action(
        self,
        *,
        owner: str,
        chat_id: int,
        session_key: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        decision = self.proactive_gate(chat_id=chat_id, session_key=session_key, now=now)
        if not bool(decision.get("allowed")):
            return decision
        self._proactive_action_in_flight = True
        self._proactive_action_owner = str(owner or "unknown")
        self._last_proactive_action_at = (now or datetime.now(UTC)).isoformat()
        self._last_proactive_action_reason = "claimed"
        return {"allowed": True, "reason": "claimed"}

    def finish_proactive_action(self, *, owner: str, reason: str = "") -> None:
        if self._proactive_action_owner and self._proactive_action_owner != str(owner or ""):
            return
        self._proactive_action_in_flight = False
        self._proactive_action_owner = ""
        self._last_proactive_action_reason = str(reason or "released")

    def mark_degraded(self, reason: str) -> None:
        self._degraded = True
        self._degraded_reason = str(reason or "")
        if self._shared_mind_state is not None:
            self._shared_mind_state.set_health(degraded=True, last_error=self._degraded_reason)

    def clear_degraded(self) -> None:
        self._degraded = False
        self._degraded_reason = ""
        if self._shared_mind_state is not None:
            self._shared_mind_state.set_health(degraded=False, last_error="")

    def _ordered_loops(self) -> list[ManagedLoop]:
        return sorted(self._loops.values(), key=lambda loop: (int(loop.priority), loop.name))

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()
