from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.followups import FollowUpStore
from drost.idle_state import IdleStateStore

logger = logging.getLogger(__name__)


class IdleHeartbeatRunner:
    def __init__(
        self,
        *,
        workspace_dir: str | Path,
        followups: FollowUpStore,
        idle_state: IdleStateStore,
        send_message: Callable[[int, str], Awaitable[Any]],
        enabled: bool,
        proactive_enabled: bool,
        interval_seconds: int = 1800,
        active_window_seconds: int = 20 * 60,
        proactive_cooldown_seconds: int = 6 * 60 * 60,
        max_due_items: int = 5,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._followups = followups
        self._idle_state = idle_state
        self._send_message = send_message
        self._enabled = bool(enabled)
        self._proactive_enabled = bool(proactive_enabled)
        self._interval_seconds = max(60, int(interval_seconds))
        self._active_window_seconds = max(60, int(active_window_seconds))
        self._proactive_cooldown_seconds = max(60, int(proactive_cooldown_seconds))
        self._max_due_items = max(1, int(max_due_items))
        self._task: asyncio.Task[None] | None = None
        self._run_lock = asyncio.Lock()
        self._running = False
        self._last_status: dict[str, Any] = {
            "enabled": self._enabled,
            "proactive_enabled": self._proactive_enabled,
            "running": False,
            "interval_seconds": self._interval_seconds,
            "active_window_seconds": self._active_window_seconds,
            "proactive_cooldown_seconds": self._proactive_cooldown_seconds,
            "last_run_at": "",
            "last_error": "",
            "last_result": {},
        }

    async def start(self) -> None:
        if not self._enabled or self._running:
            return
        self._running = True
        self._last_status["running"] = True
        self._task = asyncio.create_task(self._loop())
        asyncio.create_task(self.run_once(reason="startup"))
        logger.info(
            "Idle heartbeat runner started (interval=%ss proactive=%s)",
            self._interval_seconds,
            self._proactive_enabled,
        )

    async def stop(self) -> None:
        self._running = False
        self._last_status["running"] = False
        if self._task is None:
            return
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        self._task = None
        logger.info("Idle heartbeat runner stopped")

    async def _loop(self) -> None:
        tick_seconds = min(60, self._interval_seconds)
        while self._running:
            try:
                await asyncio.sleep(tick_seconds)
                await self.run_once(reason="tick")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Idle heartbeat loop error")

    def status(self) -> dict[str, Any]:
        state = self._idle_state.status(active_window_seconds=self._active_window_seconds)
        result = dict(self._last_status)
        result["idle_state"] = state
        result["followup_counts"] = {
            "all": len(self._followups.list_followups(chat_id=int(state.get("active_chat_id") or 0) or None)),
            "due": len(
                self._followups.list_due(
                    chat_id=int(state.get("active_chat_id") or 0) or None,
                    limit=self._max_due_items,
                )
            ),
        }
        return result

    async def run_once(self, *, reason: str = "manual", now: datetime | None = None) -> dict[str, Any]:
        async with self._run_lock:
            started_at = now or datetime.now(UTC)
            self._last_status["last_run_at"] = started_at.isoformat()
            state = self._idle_state.refresh(
                active_window_seconds=self._active_window_seconds,
                now=started_at,
            )
            chat_id = int(state.get("active_chat_id") or 0)
            mode = str(state.get("mode") or "active")
            last_heartbeat_at = _parse_time(state.get("last_heartbeat_at"))

            if mode == "active":
                result = {"reason": reason, "decision": "noop", "why": "active_mode", "chat_id": chat_id}
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result

            if reason == "tick" and last_heartbeat_at is not None:
                elapsed = (started_at - last_heartbeat_at).total_seconds()
                if elapsed < self._interval_seconds and not bool(state.get("mode_changed")):
                    result = {"reason": reason, "decision": "noop", "why": "interval_not_elapsed", "chat_id": chat_id}
                    self._last_status["last_result"] = result
                    self._last_status["last_error"] = ""
                    return result

            self._idle_state.note_heartbeat(at=started_at)

            if chat_id <= 0:
                result = {"reason": reason, "decision": "noop", "why": "no_active_chat"}
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result

            due_items = self._followups.list_due(now=started_at, chat_id=chat_id, limit=self._max_due_items)
            if not due_items:
                result = {"reason": reason, "decision": "noop", "why": "no_due_followups", "chat_id": chat_id}
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result

            if not self._proactive_enabled:
                result = {
                    "reason": reason,
                    "decision": "noop",
                    "why": "proactive_disabled",
                    "chat_id": chat_id,
                    "due_followup_ids": [str(item.get("id") or "") for item in due_items],
                }
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result

            followup = due_items[0]
            message = str(followup.get("follow_up_prompt") or "").strip()
            if not message:
                result = {
                    "reason": reason,
                    "decision": "noop",
                    "why": "missing_prompt",
                    "chat_id": chat_id,
                    "follow_up_id": str(followup.get("id") or ""),
                }
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result

            try:
                await self._send_message(chat_id, message)
                self._followups.mark_surfaced(
                    str(followup.get("id") or ""),
                    surfaced_at=started_at,
                    suppress_for_seconds=self._proactive_cooldown_seconds,
                )
                self._idle_state.note_proactive_surface(
                    chat_id=chat_id,
                    at=started_at,
                    cooldown_seconds=self._proactive_cooldown_seconds,
                )
                result = {
                    "reason": reason,
                    "decision": "surface_follow_up",
                    "chat_id": chat_id,
                    "follow_up_id": str(followup.get("id") or ""),
                    "message": message,
                }
                self._last_status["last_result"] = result
                self._last_status["last_error"] = ""
                return result
            except Exception as exc:
                logger.warning("Idle heartbeat proactive send failed", exc_info=True)
                self._last_status["last_error"] = str(exc)
                result = {
                    "reason": reason,
                    "decision": "noop",
                    "why": "send_failed",
                    "chat_id": chat_id,
                    "follow_up_id": str(followup.get("id") or ""),
                    "error": str(exc),
                }
                self._last_status["last_result"] = result
                return result


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
