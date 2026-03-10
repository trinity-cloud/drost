from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from drost.followups import FollowUpStore
from drost.idle_state import IdleStateStore
from drost.loop_events import EventSubscription, LoopEventBus
from drost.providers import BaseProvider, Message, MessageRole
from drost.workspace_loader import WorkspaceLoader

logger = logging.getLogger(__name__)

_JSON_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\n?|\n?```$", re.MULTILINE)
_ALLOWED_DECISIONS = {"noop", "surface_follow_up", "snooze_follow_up", "mark_expired"}
_HEARTBEAT_SYSTEM_PROMPT = """You are the Drost idle heartbeat decision engine.

You are reviewing due follow-ups while the user is idle.
Return ONLY valid JSON. No markdown. No prose before or after the JSON.

Output schema:
{
  "decision": "noop" | "surface_follow_up" | "snooze_follow_up" | "mark_expired",
  "follow_up_id": "optional follow-up id",
  "message": "required only for surface_follow_up",
  "reason": "short factual reason",
  "confidence": 0.0,
  "snooze_until": "required only for snooze_follow_up; ISO-8601 UTC"
}

Rules:
- Be conservative. If uncertain, return noop.
- Do not initiate generic social check-ins with no concrete reason.
- Only surface a follow-up when it is genuinely due and worth interrupting for.
- Prefer the provided follow_up_prompt as the core outbound message unless you have a strong reason to tighten it.
- If surfacing, keep the message concise and natural.
- If no follow-up clearly deserves action, return noop.
"""


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
        event_bus: LoopEventBus | None = None,
        provider_getter: Callable[[], BaseProvider] | None = None,
        interval_seconds: int = 1800,
        active_window_seconds: int = 20 * 60,
        proactive_cooldown_seconds: int = 6 * 60 * 60,
        max_due_items: int = 5,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._followups = followups
        self._idle_state = idle_state
        self._send_message = send_message
        self._event_bus = event_bus
        self._provider_getter = provider_getter
        self._workspace_loader = WorkspaceLoader(self._workspace_dir)
        self._enabled = bool(enabled)
        self._proactive_enabled = bool(proactive_enabled)
        self._interval_seconds = max(60, int(interval_seconds))
        self._active_window_seconds = max(60, int(active_window_seconds))
        self._proactive_cooldown_seconds = max(60, int(proactive_cooldown_seconds))
        self._max_due_items = max(1, int(max_due_items))
        self._task: asyncio.Task[None] | None = None
        self._event_listener_task: asyncio.Task[None] | None = None
        self._event_subscription: EventSubscription | None = None
        self._trigger_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=16)
        self._run_lock = asyncio.Lock()
        self._running = False
        self._last_status: dict[str, Any] = {
            "enabled": self._enabled,
            "proactive_enabled": self._proactive_enabled,
            "provider_backed": self._provider_getter is not None,
            "running": False,
            "interval_seconds": self._interval_seconds,
            "active_window_seconds": self._active_window_seconds,
            "proactive_cooldown_seconds": self._proactive_cooldown_seconds,
            "last_run_at": "",
            "last_error": "",
            "last_result": {},
            "event_driven": self._event_bus is not None,
            "last_trigger_event": "",
        }

    async def start(self) -> None:
        if not self._enabled or self._running:
            return
        self._running = True
        self._last_status["running"] = True
        if self._event_bus is not None and self._event_subscription is None:
            self._event_subscription = self._event_bus.subscribe(
                name="heartbeat_loop",
                event_types={
                    "assistant_turn_completed",
                    "followup_created",
                    "followup_updated",
                    "continuity_written",
                    "session_switched",
                },
            )
            self._event_listener_task = asyncio.create_task(self._listen_for_events())
        self._task = asyncio.create_task(self._loop())
        asyncio.create_task(self.run_once(reason="startup"))
        logger.info(
            "Idle heartbeat runner started (interval=%ss proactive=%s provider_backed=%s)",
            self._interval_seconds,
            self._proactive_enabled,
            self._provider_getter is not None,
        )

    async def stop(self) -> None:
        self._running = False
        self._last_status["running"] = False
        if self._task is None:
            if self._event_listener_task is not None:
                self._event_listener_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._event_listener_task
                self._event_listener_task = None
            if self._event_subscription is not None:
                self._event_bus and self._event_bus.unsubscribe(self._event_subscription.name)
                self._event_subscription = None
            return
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        self._task = None
        if self._event_listener_task is not None:
            self._event_listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._event_listener_task
            self._event_listener_task = None
        if self._event_subscription is not None:
            self._event_bus and self._event_bus.unsubscribe(self._event_subscription.name)
            self._event_subscription = None
        logger.info("Idle heartbeat runner stopped")

    async def _loop(self) -> None:
        while self._running:
            try:
                trigger_reason = await self._next_trigger_reason()
                await self.run_once(reason=trigger_reason)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Idle heartbeat loop error")

    async def _listen_for_events(self) -> None:
        subscription = self._event_subscription
        if subscription is None:
            return
        while self._running and subscription.active:
            try:
                event = await subscription.get()
            except asyncio.CancelledError:
                break
            self._last_status["last_trigger_event"] = event.type
            self._enqueue_trigger(f"event:{event.type}")

    async def _next_trigger_reason(self) -> str:
        tick_seconds = min(60, self._interval_seconds)
        try:
            return await asyncio.wait_for(self._trigger_queue.get(), timeout=tick_seconds)
        except TimeoutError:
            return "tick"

    def _enqueue_trigger(self, reason: str) -> None:
        try:
            self._trigger_queue.put_nowait(str(reason or "event"))
        except asyncio.QueueFull:
            with suppress(asyncio.QueueEmpty):
                self._trigger_queue.get_nowait()
            with suppress(asyncio.QueueFull):
                self._trigger_queue.put_nowait(str(reason or "event"))

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
                result = self._record_result(
                    {"reason": reason, "decision": "noop", "why": "active_mode", "chat_id": chat_id}
                )
                self._emit_heartbeat_decision(result)
                return result

            if reason == "tick" and last_heartbeat_at is not None:
                elapsed = (started_at - last_heartbeat_at).total_seconds()
                if elapsed < self._interval_seconds and not bool(state.get("mode_changed")):
                    result = self._record_result(
                        {"reason": reason, "decision": "noop", "why": "interval_not_elapsed", "chat_id": chat_id}
                    )
                    self._emit_heartbeat_decision(result)
                    return result

            self._idle_state.note_heartbeat(at=started_at)

            if chat_id <= 0:
                result = self._record_result({"reason": reason, "decision": "noop", "why": "no_active_chat"})
                self._emit_heartbeat_decision(result)
                return result

            due_items = self._followups.list_due(now=started_at, chat_id=chat_id, limit=self._max_due_items)
            if not due_items:
                result = self._record_result(
                    {"reason": reason, "decision": "noop", "why": "no_due_followups", "chat_id": chat_id}
                )
                self._emit_heartbeat_decision(result)
                return result

            if not self._proactive_enabled:
                result = self._record_result(
                    {
                        "reason": reason,
                        "decision": "noop",
                        "why": "proactive_disabled",
                        "chat_id": chat_id,
                        "due_followup_ids": [str(item.get("id") or "") for item in due_items],
                    }
                )
                self._emit_heartbeat_decision(result)
                return result

            decision = await self._decide(
                due_items=due_items,
                idle_state=state,
                now=started_at,
                reason=reason,
            )
            decision.setdefault("reason", reason)
            decision["chat_id"] = chat_id

            followup = self._resolve_followup(decision.get("follow_up_id"), due_items)
            action = str(decision.get("decision") or "noop")
            if action == "noop":
                result = self._record_result(decision)
                self._emit_heartbeat_decision(result)
                return result

            if followup is None:
                fallback = self._deterministic_decision(due_items=due_items)
                fallback["reason"] = "invalid_follow_up_reference"
                followup = due_items[0]
                decision = {**fallback, "chat_id": chat_id}
                action = str(decision.get("decision") or "noop")

            if action == "mark_expired":
                updated = self._followups.expire(str(followup.get("id") or "")) or followup
                self._emit_followup_updated(updated, source="heartbeat_expired")
                result = self._record_result(decision)
                self._emit_heartbeat_decision(result)
                return result

            if action == "snooze_follow_up":
                snooze_until = _parse_time(decision.get("snooze_until"))
                if snooze_until is None:
                    fallback_until = started_at + timedelta(seconds=self._proactive_cooldown_seconds)
                    snooze_until = fallback_until
                    decision["snooze_until"] = _dump_time(snooze_until)
                updated = self._followups.snooze(str(followup.get("id") or ""), until=snooze_until) or followup
                self._emit_followup_updated(updated, source="heartbeat_snoozed")
                result = self._record_result(decision)
                self._emit_heartbeat_decision(result)
                return result

            message = str(decision.get("message") or followup.get("follow_up_prompt") or "").strip()
            if not message:
                result = self._record_result(
                    {
                        "reason": reason,
                        "decision": "noop",
                        "why": "missing_prompt",
                        "chat_id": chat_id,
                        "follow_up_id": str(followup.get("id") or ""),
                    }
                )
                self._emit_heartbeat_decision(result)
                return result

            try:
                await self._send_message(chat_id, message)
                updated = self._followups.mark_surfaced(
                    str(followup.get("id") or ""),
                    surfaced_at=started_at,
                    suppress_for_seconds=self._proactive_cooldown_seconds,
                ) or followup
                self._idle_state.note_proactive_surface(
                    chat_id=chat_id,
                    at=started_at,
                    cooldown_seconds=self._proactive_cooldown_seconds,
                )
                decision["decision"] = "surface_follow_up"
                decision["follow_up_id"] = str(followup.get("id") or "")
                decision["message"] = message
                self._emit_followup_updated(updated, source="heartbeat_surfaced")
                self._emit_proactive_surface(
                    chat_id=chat_id,
                    follow_up_id=str(followup.get("id") or ""),
                    session_key=str(state.get("active_session_key") or ""),
                    message=message,
                )
                result = self._record_result(decision)
                self._emit_heartbeat_decision(result)
                return result
            except Exception as exc:
                logger.warning("Idle heartbeat proactive send failed", exc_info=True)
                self._last_status["last_error"] = str(exc)
                result = self._record_result(
                    {
                        "reason": reason,
                        "decision": "noop",
                        "why": "send_failed",
                        "chat_id": chat_id,
                        "follow_up_id": str(followup.get("id") or ""),
                        "error": str(exc),
                    }
                )
                self._emit_heartbeat_decision(result)
                return result

    async def _decide(
        self,
        *,
        due_items: list[dict[str, Any]],
        idle_state: dict[str, Any],
        now: datetime,
        reason: str,
    ) -> dict[str, Any]:
        if self._provider_getter is None:
            return self._deterministic_decision(due_items=due_items)

        try:
            provider = self._provider_getter()
        except Exception:
            logger.warning("Idle heartbeat provider getter failed; falling back to deterministic decision", exc_info=True)
            return self._deterministic_decision(due_items=due_items)

        system = self._build_system_prompt()
        user_payload = self._build_user_payload(
            due_items=due_items,
            idle_state=idle_state,
            now=now,
            reason=reason,
        )
        try:
            response = await provider.chat(
                messages=[Message(role=MessageRole.USER, content=user_payload)],
                system=system,
                max_tokens=600,
                temperature=0,
            )
        except Exception:
            logger.warning("Idle heartbeat provider decision failed; falling back to deterministic decision", exc_info=True)
            return self._deterministic_decision(due_items=due_items)

        payload = self._parse_json(str(response.message.content or ""))
        normalized = self._normalize_decision(payload=payload, due_items=due_items)
        if normalized is None:
            logger.warning("Idle heartbeat provider returned invalid decision; falling back to deterministic decision")
            return self._deterministic_decision(due_items=due_items)
        return normalized

    def _build_system_prompt(self) -> str:
        workspace = self._workspace_loader.load(include_heartbeat=True, include_memory_md=False)
        sections = [_HEARTBEAT_SYSTEM_PROMPT]
        if workspace.heartbeat_md:
            sections.append(f"[Workspace: HEARTBEAT.md]\n{workspace.heartbeat_md}")
        return "\n\n".join(section for section in sections if section).strip()

    def _build_user_payload(
        self,
        *,
        due_items: list[dict[str, Any]],
        idle_state: dict[str, Any],
        now: datetime,
        reason: str,
    ) -> str:
        workspace = self._workspace_loader.load(include_heartbeat=True, include_memory_md=False)
        recent_daily = [
            {"path": name, "content": body[-3000:]}
            for name, body in workspace.daily_memory[:2]
        ]
        payload = {
            "current_time": _dump_time(now),
            "trigger_reason": reason,
            "idle_state": {
                "mode": idle_state.get("mode"),
                "last_user_message_at": idle_state.get("last_user_message_at"),
                "last_proactive_surface_at": idle_state.get("last_proactive_surface_at"),
                "proactive_cooldown_until": idle_state.get("proactive_cooldown_until"),
            },
            "due_followups": [
                {
                    "id": str(item.get("id") or ""),
                    "subject": str(item.get("subject") or ""),
                    "follow_up_prompt": str(item.get("follow_up_prompt") or ""),
                    "priority": str(item.get("priority") or "medium"),
                    "due_at": str(item.get("due_at") or ""),
                    "not_before": str(item.get("not_before") or ""),
                    "last_surfaced_at": str(item.get("last_surfaced_at") or ""),
                    "source_excerpt": str(item.get("source_excerpt") or ""),
                    "notes": str(item.get("notes") or ""),
                    "entity_refs": list(item.get("entity_refs") or []),
                }
                for item in due_items
            ],
            "recent_daily_memory": recent_daily,
        }
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def _parse_json(raw: str) -> dict[str, Any] | None:
        cleaned = _JSON_FENCE_RE.sub("", str(raw or "").strip()).strip()
        if not cleaned:
            return None
        try:
            payload = json.loads(cleaned)
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _normalize_decision(*, payload: dict[str, Any] | None, due_items: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None
        action = str(payload.get("decision") or "").strip().lower()
        if action not in _ALLOWED_DECISIONS:
            return None
        follow_up_id = str(payload.get("follow_up_id") or "").strip()
        if not follow_up_id and len(due_items) == 1 and action != "noop":
            follow_up_id = str(due_items[0].get("id") or "")
        decision: dict[str, Any] = {
            "decision": action,
            "follow_up_id": follow_up_id,
            "message": str(payload.get("message") or "").strip(),
            "reason": str(payload.get("reason") or "").strip(),
        }
        try:
            decision["confidence"] = float(payload.get("confidence") or 0.0)
        except Exception:
            decision["confidence"] = 0.0
        snooze_until = str(payload.get("snooze_until") or "").strip()
        if snooze_until:
            decision["snooze_until"] = snooze_until
        if action == "noop":
            return decision
        if not any(str(item.get("id") or "") == follow_up_id for item in due_items):
            return None
        if action == "surface_follow_up":
            return decision
        if action == "mark_expired":
            return decision
        if action == "snooze_follow_up":
            return decision
        return None

    @staticmethod
    def _resolve_followup(follow_up_id: Any, due_items: list[dict[str, Any]]) -> dict[str, Any] | None:
        cleaned = str(follow_up_id or "").strip()
        if cleaned:
            for item in due_items:
                if str(item.get("id") or "") == cleaned:
                    return item
        return due_items[0] if due_items else None

    @staticmethod
    def _deterministic_decision(*, due_items: list[dict[str, Any]]) -> dict[str, Any]:
        followup = due_items[0] if due_items else None
        if followup is None:
            return {"decision": "noop", "reason": "no_due_followups", "confidence": 0.0}
        return {
            "decision": "surface_follow_up",
            "follow_up_id": str(followup.get("id") or ""),
            "message": str(followup.get("follow_up_prompt") or "").strip(),
            "reason": "deterministic_fallback_first_due_item",
            "confidence": 0.5,
        }

    def _record_result(self, result: dict[str, Any]) -> dict[str, Any]:
        self._last_status["last_result"] = result
        self._last_status["last_error"] = str(result.get("error") or "")
        return result

    def _emit_heartbeat_decision(self, result: dict[str, Any]) -> None:
        if self._event_bus is None:
            return
        current_state = self._idle_state.status(active_window_seconds=self._active_window_seconds)
        self._event_bus.emit(
            "heartbeat_decision_made",
            scope={
                "chat_id": int(result.get("chat_id") or 0),
                "session_key": str(current_state.get("active_session_key") or ""),
            },
            payload=dict(result),
        )

    def _emit_followup_updated(self, followup: dict[str, Any], *, source: str) -> None:
        if self._event_bus is None:
            return
        self._event_bus.emit(
            "followup_updated",
            scope={
                "chat_id": int(followup.get("chat_id") or 0),
                "session_key": str(followup.get("source_session_key") or ""),
            },
            payload={
                "follow_up_id": str(followup.get("id") or ""),
                "status": str(followup.get("status") or ""),
                "subject": str(followup.get("subject") or ""),
                "source": source,
            },
        )

    def _emit_proactive_surface(
        self,
        *,
        chat_id: int,
        follow_up_id: str,
        session_key: str,
        message: str,
    ) -> None:
        if self._event_bus is None:
            return
        self._event_bus.emit(
            "proactive_surface_sent",
            scope={
                "chat_id": int(chat_id),
                "session_key": str(session_key or ""),
            },
            payload={
                "follow_up_id": str(follow_up_id or ""),
                "message": str(message or ""),
            },
        )


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


def _dump_time(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
