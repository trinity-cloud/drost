from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.cognitive_artifacts import CognitiveArtifactStore, DriveStateSnapshot
from drost.followups import FollowUpStore
from drost.loop_events import EventSubscription, LoopEvent, LoopEventBus
from drost.managed_loop import LoopLifecycleState, LoopPriority, LoopVisibility, ManagedLoop
from drost.providers import BaseProvider, Message, MessageRole
from drost.shared_mind_state import SharedMindState

logger = logging.getLogger(__name__)

_JSON_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\n?|\n?```$", re.MULTILINE)
_DRIVE_SYSTEM_PROMPT = """You are the Drost drive loop.

You are not answering the user. You are updating Drost's internal agenda.
Return ONLY valid JSON. No markdown. No prose before or after the JSON.

Output schema:
{
  "active_items": [
    {
      "drive_id": "optional stable id",
      "title": "short title",
      "summary": "short internal summary",
      "kind": "goal|responsibility|opportunity|open_thread|concern",
      "status": "active",
      "priority": 0.0,
      "urgency": 0.0,
      "confidence": 0.0,
      "recommended_channel": "heartbeat|conversation_only|hold",
      "source_refs": ["short reference", "..."],
      "next_review_at": "optional ISO-8601 UTC"
    }
  ],
  "completed_items": [],
  "suppressed_items": [],
  "attention": {
    "current_focus_kind": "drive",
    "current_focus_summary": "short summary",
    "top_priority_tags": ["tag", "..."],
    "reflection_stale": false,
    "drive_stale": false
  }
}

Rules:
- Return at most 5 active items.
- Preserve still-relevant existing agenda items when possible instead of churning ids gratuitously.
- Prefer specific, stable agenda items over vague reminders.
- `recommended_channel` should usually be `conversation_only` or `hold`; use `heartbeat` conservatively.
- Do not create user-facing prose.
- If there is little to care about, return a small agenda rather than inventing urgency.
"""


class DriveLoop(ManagedLoop):
    def __init__(
        self,
        *,
        workspace_dir: str | Path,
        provider_getter: Callable[[], BaseProvider],
        shared_mind_state: SharedMindState,
        followups: FollowUpStore,
        artifact_store: CognitiveArtifactStore | None = None,
        event_bus: LoopEventBus | None = None,
        policy_gate: Callable[[str], dict[str, Any]] | None = None,
        enabled: bool = True,
        interval_seconds: int = 1800,
        followup_lookahead_hours: int = 168,
        max_reflections: int = 8,
        max_followups: int = 10,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._provider_getter = provider_getter
        self._shared_mind_state = shared_mind_state
        self._followups = followups
        self._artifact_store = artifact_store or CognitiveArtifactStore(self._workspace_dir)
        self._event_bus = event_bus
        self._policy_gate = policy_gate
        self._enabled = bool(enabled)
        self._interval_seconds = max(300, int(interval_seconds))
        self._followup_lookahead_hours = max(1, int(followup_lookahead_hours))
        self._max_reflections = max(1, int(max_reflections))
        self._max_followups = max(1, int(max_followups))

        self._state = LoopLifecycleState.REGISTERED
        self._task: asyncio.Task[None] | None = None
        self._event_listener_task: asyncio.Task[None] | None = None
        self._event_subscription: EventSubscription | None = None
        self._trigger_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=16)
        self._run_lock = asyncio.Lock()
        self._running = False
        self._last_started_at = ""
        self._last_stopped_at = ""
        self._last_error = ""
        self._last_failure_at = ""
        self._start_count = 0
        self._stop_count = 0
        self._failure_count = 0
        self._recovery_count = 0
        self._last_status: dict[str, Any] = {
            "enabled": self._enabled,
            "running": False,
            "interval_seconds": self._interval_seconds,
            "followup_lookahead_hours": self._followup_lookahead_hours,
            "max_reflections": self._max_reflections,
            "max_followups": self._max_followups,
            "provider_backed": True,
            "event_driven": self._event_bus is not None,
            "last_run_at": "",
            "last_success_at": "",
            "last_trigger_event": "",
            "last_policy_reason": "",
            "last_result": {},
        }

    @property
    def name(self) -> str:
        return "drive_loop"

    @property
    def priority(self) -> LoopPriority:
        return LoopPriority.NORMAL

    @property
    def visibility(self) -> LoopVisibility:
        return LoopVisibility.BACKGROUND

    async def start(self) -> None:
        prior_state = self._state
        try:
            if not self._enabled or self._running:
                return
            self._artifact_store.ensure_layout()
            self._running = True
            self._last_status["running"] = True
            if self._event_bus is not None and self._event_subscription is None:
                self._event_subscription = self._event_bus.subscribe(
                    name=self.name,
                    event_types={
                        "reflection_written",
                        "followup_created",
                        "followup_updated",
                        "memory_maintenance_completed",
                        "continuity_written",
                    },
                )
                self._event_listener_task = asyncio.create_task(self._listen_for_events())
            self._task = asyncio.create_task(self._loop())
            asyncio.create_task(self.run_once(reason="startup"))
        except Exception as exc:
            self._state = LoopLifecycleState.FAILED
            self._last_error = str(exc)
            self._last_failure_at = self._utc_now()
            self._failure_count += 1
            raise
        if prior_state == LoopLifecycleState.FAILED:
            self._recovery_count += 1
        self._state = LoopLifecycleState.RUNNING
        self._last_started_at = self._utc_now()
        self._start_count += 1
        self._last_error = ""
        logger.info(
            "Drive loop started (interval=%ss followup_lookahead=%sh)",
            self._interval_seconds,
            self._followup_lookahead_hours,
        )

    async def stop(self) -> None:
        try:
            self._running = False
            self._last_status["running"] = False
            if self._task is not None:
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
        except Exception as exc:
            self._state = LoopLifecycleState.FAILED
            self._last_error = str(exc)
            self._last_failure_at = self._utc_now()
            self._failure_count += 1
            raise
        self._state = LoopLifecycleState.STOPPED
        self._last_stopped_at = self._utc_now()
        self._stop_count += 1
        logger.info("Drive loop stopped")

    def status(self) -> dict[str, Any]:
        details = dict(self._last_status)
        details.update(
            {
                "name": self.name,
                "priority": int(self.priority),
                "visibility": str(self.visibility),
                "state": str(self._state),
                "last_started_at": self._last_started_at,
                "last_stopped_at": self._last_stopped_at,
                "last_error": self._last_error,
                "last_failure_at": self._last_failure_at,
                "start_count": self._start_count,
                "stop_count": self._stop_count,
                "failure_count": self._failure_count,
                "recovery_count": self._recovery_count,
            }
        )
        return details

    async def _loop(self) -> None:
        while self._running:
            try:
                trigger = await self._next_trigger()
                await self.run_once(
                    reason=str(trigger.get("reason") or "tick"),
                    event_scope=trigger.get("scope") if isinstance(trigger.get("scope"), dict) else None,
                )
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Drive loop error")

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
            self._enqueue_trigger(event)

    async def _next_trigger(self) -> dict[str, Any]:
        tick_seconds = min(60, self._interval_seconds)
        try:
            return await asyncio.wait_for(self._trigger_queue.get(), timeout=tick_seconds)
        except TimeoutError:
            return {"reason": "tick", "scope": {}}

    def _enqueue_trigger(self, event: LoopEvent) -> None:
        payload = {
            "reason": f"event:{event.type}",
            "scope": dict(event.scope),
        }
        try:
            self._trigger_queue.put_nowait(payload)
        except asyncio.QueueFull:
            with suppress(asyncio.QueueEmpty):
                self._trigger_queue.get_nowait()
            with suppress(asyncio.QueueFull):
                self._trigger_queue.put_nowait(payload)

    async def run_once(
        self,
        *,
        reason: str = "manual",
        event_scope: dict[str, Any] | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        async with self._run_lock:
            started_at = now or datetime.now(UTC)
            self._last_status["last_run_at"] = _dump_time(started_at)

            if self._policy_gate is not None:
                policy = self._policy_gate(self.name)
                self._last_status["last_policy_reason"] = str(policy.get("reason") or "")
                if not bool(policy.get("allowed")):
                    result = {
                        "reason": reason,
                        "agenda_items_written": 0,
                        "policy_blocked": str(policy.get("reason") or "policy_blocked"),
                    }
                    self._last_status["last_result"] = result
                    self._last_error = ""
                    return result

            if reason not in {"manual", "startup"}:
                last_success = _parse_time(self._last_status.get("last_success_at"))
                if last_success is not None:
                    elapsed = (started_at - last_success).total_seconds()
                    if elapsed < self._interval_seconds:
                        result = {
                            "reason": reason,
                            "agenda_items_written": 0,
                            "why": "interval_not_elapsed",
                        }
                        self._last_status["last_result"] = result
                        self._last_error = ""
                        return result

            focus = dict(self._shared_mind_state.snapshot().get("focus") or {})
            scope = dict(event_scope or {})
            session_key = str(scope.get("session_key") or focus.get("session_key") or "").strip()
            chat_id = int(scope.get("chat_id") or focus.get("chat_id") or 0)

            reflections = self._artifact_store.list_reflections(limit=self._max_reflections)
            followups = self._followups.list_relevant(
                chat_id=chat_id or None,
                limit=self._max_followups,
                lookahead_hours=self._followup_lookahead_hours,
            )
            current_drive_state = self._artifact_store.load_drive_state()
            current_attention_state = self._artifact_store.load_attention_state()

            if not reflections and not followups and not list(current_drive_state.get("active_items") or []):
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "agenda_items_written": 0,
                    "why": "no_inputs",
                }
                self._last_status["last_result"] = result
                self._last_error = ""
                self._last_status["last_success_at"] = _dump_time(started_at)
                return result

            try:
                provider = self._provider_getter()
                response = await provider.chat(
                    messages=[Message(role=MessageRole.USER, content=self._build_user_payload(
                        reason=reason,
                        chat_id=chat_id,
                        session_key=session_key,
                        reflections=reflections,
                        followups=followups,
                        current_drive_state=current_drive_state,
                        current_attention_state=current_attention_state,
                    ))],
                    system=_DRIVE_SYSTEM_PROMPT,
                    max_tokens=1500,
                    temperature=0,
                )
                payload = self._parse_payload(str(response.message.content or ""))
            except Exception as exc:
                logger.warning("Drive loop provider call failed", exc_info=True)
                self._last_error = str(exc)
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "agenda_items_written": 0,
                    "error": str(exc),
                }
                self._last_status["last_result"] = result
                return result

            snapshot_payload = {
                "updated_at": _dump_time(started_at),
                "generated_at": _dump_time(started_at),
                "active_items": list(payload.get("active_items") or []),
                "completed_items": list(payload.get("completed_items") or []),
                "suppressed_items": list(payload.get("suppressed_items") or []),
            }
            drive_state = self._artifact_store.replace_drive_state(snapshot_payload)
            attention_payload = dict(payload.get("attention") or {})
            active_items = list(drive_state.get("active_items") or [])
            top_item = active_items[0] if active_items else {}
            if not attention_payload:
                attention_payload = {
                    "current_focus_kind": "drive",
                    "current_focus_summary": str(top_item.get("summary") or top_item.get("title") or ""),
                    "top_priority_tags": [str(item.get("kind") or "").strip() for item in active_items[:3] if str(item.get("kind") or "").strip()],
                }
            attention_payload.setdefault("updated_at", _dump_time(started_at))
            attention_payload.setdefault("current_focus_kind", "drive")
            self._artifact_store.replace_attention_state(attention_payload)

            if self._event_bus is not None:
                self._event_bus.emit(
                    "drive_updated",
                    scope={
                        "chat_id": chat_id,
                        "session_key": session_key,
                    },
                    payload={
                        "count": len(active_items),
                        "drive_ids": [str(item.get("drive_id") or "") for item in active_items],
                        "reason": reason,
                    },
                )

            result = {
                "reason": reason,
                "chat_id": chat_id,
                "session_key": session_key,
                "agenda_items_written": len(active_items),
                "drive_ids": [str(item.get("drive_id") or "") for item in active_items],
                "why": "ok",
            }
            self._last_status["last_result"] = result
            self._last_status["last_success_at"] = _dump_time(started_at)
            self._last_error = ""
            return result

    def _build_user_payload(
        self,
        *,
        reason: str,
        chat_id: int,
        session_key: str,
        reflections: list[dict[str, Any]],
        followups: list[dict[str, Any]],
        current_drive_state: dict[str, Any],
        current_attention_state: dict[str, Any],
    ) -> str:
        payload = {
            "current_time": _dump_time(datetime.now(UTC)),
            "trigger_reason": reason,
            "chat_id": int(chat_id),
            "session_key": session_key,
            "recent_reflections": [
                {
                    "reflection_id": str(item.get("reflection_id") or ""),
                    "timestamp": str(item.get("timestamp") or ""),
                    "kind": str(item.get("kind") or ""),
                    "summary": str(item.get("summary") or ""),
                    "importance": item.get("importance", 0.0),
                    "novelty": item.get("novelty", 0.0),
                    "actionability": item.get("actionability", 0.0),
                    "suggested_drive_tags": list(item.get("suggested_drive_tags") or []),
                }
                for item in reflections
            ],
            "relevant_followups": [
                {
                    "id": str(item.get("id") or ""),
                    "subject": str(item.get("subject") or ""),
                    "follow_up_prompt": str(item.get("follow_up_prompt") or ""),
                    "priority": str(item.get("priority") or "medium"),
                    "due_at": str(item.get("due_at") or ""),
                    "status": str(item.get("status") or ""),
                    "entity_refs": list(item.get("entity_refs") or []),
                    "source_excerpt": str(item.get("source_excerpt") or ""),
                }
                for item in followups
            ],
            "current_drive_state": current_drive_state,
            "current_attention_state": current_attention_state,
            "shared_mind": {
                "mode": str(self._shared_mind_state.snapshot().get("mode") or "active"),
                "focus": dict(self._shared_mind_state.snapshot().get("focus") or {}),
            },
        }
        return json.dumps(payload, ensure_ascii=False)

    @staticmethod
    def _parse_payload(raw: str) -> dict[str, Any]:
        cleaned = _JSON_FENCE_RE.sub("", str(raw or "").strip()).strip()
        if not cleaned:
            return {"active_items": [], "completed_items": [], "suppressed_items": [], "attention": {}}
        try:
            payload = json.loads(cleaned)
        except Exception:
            return {"active_items": [], "completed_items": [], "suppressed_items": [], "attention": {}}
        if not isinstance(payload, dict):
            return {"active_items": [], "completed_items": [], "suppressed_items": [], "attention": {}}
        payload.setdefault("active_items", [])
        payload.setdefault("completed_items", [])
        payload.setdefault("suppressed_items", [])
        payload.setdefault("attention", {})
        normalized = DriveStateSnapshot.from_input(
            {
                "updated_at": payload.get("updated_at"),
                "generated_at": payload.get("generated_at"),
                "active_items": payload.get("active_items"),
                "completed_items": payload.get("completed_items"),
                "suppressed_items": payload.get("suppressed_items"),
            }
        ).as_dict()
        return {
            "active_items": normalized["active_items"][:5],
            "completed_items": normalized["completed_items"][:5],
            "suppressed_items": normalized["suppressed_items"][:5],
            "attention": dict(payload.get("attention") or {}),
        }

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(UTC).isoformat()


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


def _dump_time(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
