from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.loop_events import EventSubscription, LoopEvent, LoopEventBus
from drost.managed_loop import LoopLifecycleState, LoopPriority, LoopVisibility, ManagedLoop
from drost.providers import BaseProvider, Message, MessageRole
from drost.shared_mind_state import SharedMindState
from drost.storage.keys import session_key_to_filename
from drost.workspace_loader import WorkspaceLoader

logger = logging.getLogger(__name__)

_JSON_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\n?|\n?```$", re.MULTILINE)
_REFLECTION_SYSTEM_PROMPT = """You are the Drost reflection loop.

You are not answering the user. You are generating bounded internal reflections about recent experience.
Return ONLY valid JSON. No markdown. No prose before or after the JSON.

Output schema:
{
  "decision": "write_reflections" | "skip_reflection",
  "skip_reason": "optional short reason",
  "reflections": [
    {
      "kind": "pattern|tension|insight|unresolved|identity_shift",
      "summary": "short internal reflection",
      "evidence": ["short source reference", "..."],
      "importance": 0.0,
      "novelty": 0.0,
      "actionability": 0.0,
      "suggested_drive_tags": ["short_tag", "..."]
    }
  ]
}

Rules:
- Return at most 3 reflections.
- Be selective. If nothing important emerged, return {"decision":"skip_reflection","skip_reason":"short reason","reflections":[]}.
- Do not restate raw facts unless they matter as a pattern or tension.
- Prefer concrete observations tied to recent events.
- Keep summaries concise and operationally useful.
- Do not produce user-facing prose.
- Do not mention tools or files unless they matter to the reflection.
"""


class ReflectionLoop(ManagedLoop):
    def __init__(
        self,
        *,
        workspace_dir: str | Path,
        sessions_dir: str | Path,
        provider_getter: Callable[[], BaseProvider],
        shared_mind_state: SharedMindState,
        event_bus: LoopEventBus | None = None,
        policy_gate: Callable[[str], dict[str, Any]] | None = None,
        artifact_store: CognitiveArtifactStore | None = None,
        enabled: bool = True,
        interval_seconds: int = 1800,
        max_messages: int = 12,
        max_reflections_per_run: int = 3,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._sessions_dir = Path(sessions_dir).expanduser()
        self._provider_getter = provider_getter
        self._shared_mind_state = shared_mind_state
        self._event_bus = event_bus
        self._policy_gate = policy_gate
        self._artifact_store = artifact_store or CognitiveArtifactStore(self._workspace_dir)
        self._workspace_loader = WorkspaceLoader(self._workspace_dir)
        self._enabled = bool(enabled)
        self._interval_seconds = max(300, int(interval_seconds))
        self._max_messages = max(4, int(max_messages))
        self._max_reflections_per_run = max(1, int(max_reflections_per_run))

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
            "max_messages": self._max_messages,
            "max_reflections_per_run": self._max_reflections_per_run,
            "provider_backed": True,
            "event_driven": self._event_bus is not None,
            "last_run_at": "",
            "last_success_at": "",
            "last_trigger_event": "",
            "last_policy_reason": "",
            "reflection_write_count": 0,
            "reflection_skip_count": 0,
            "consecutive_skip_count": 0,
            "last_skip_reason": "",
            "last_evaluated_at": "",
            "last_source_session_key": "",
            "last_source_fingerprint": "",
            "last_result": {},
        }

    @property
    def name(self) -> str:
        return "reflection_loop"

    @property
    def priority(self) -> LoopPriority:
        return LoopPriority.LOW

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
                        "assistant_turn_completed",
                        "memory_maintenance_completed",
                        "followup_created",
                        "followup_updated",
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
            "Reflection loop started (interval=%ss max_messages=%s)",
            self._interval_seconds,
            self._max_messages,
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
        logger.info("Reflection loop stopped")

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
                logger.exception("Reflection loop error")

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
                        "reflections_written": 0,
                        "policy_blocked": str(policy.get("reason") or "policy_blocked"),
                    }
                    return self._record_skip(
                        result,
                        skip_reason=str(policy.get("reason") or "policy_blocked"),
                        started_at=started_at,
                        session_key="",
                        fingerprint="",
                    )

            if reason not in {"manual", "startup"}:
                last_success = _parse_time(self._last_status.get("last_success_at"))
                if last_success is not None:
                    elapsed = (started_at - last_success).total_seconds()
                    if elapsed < self._interval_seconds:
                        result = {
                            "reason": reason,
                            "reflections_written": 0,
                            "why": "interval_not_elapsed",
                        }
                        return self._record_skip(
                            result,
                            skip_reason="interval_not_elapsed",
                            started_at=started_at,
                            session_key="",
                            fingerprint="",
                        )

            focus = dict(self._shared_mind_state.snapshot().get("focus") or {})
            scope = dict(event_scope or {})
            session_key = str(scope.get("session_key") or focus.get("session_key") or "").strip()
            chat_id = int(scope.get("chat_id") or focus.get("chat_id") or 0)
            transcript = self._load_recent_transcript(session_key)
            if not transcript:
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "reflections_written": 0,
                    "why": "no_recent_transcript",
                }
                return self._record_skip(
                    result,
                    skip_reason="no_recent_transcript",
                    started_at=started_at,
                    session_key=session_key,
                    fingerprint="",
                )

            transcript_fingerprint = self._transcript_fingerprint(transcript)
            if self._should_skip_for_unchanged_source(
                reason=reason,
                session_key=session_key,
                transcript_fingerprint=transcript_fingerprint,
            ):
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "reflections_written": 0,
                    "why": "no_new_signal",
                }
                return self._record_skip(
                    result,
                    skip_reason="no_new_signal",
                    started_at=started_at,
                    session_key=session_key,
                    fingerprint=transcript_fingerprint,
                )

            try:
                provider = self._provider_getter()
                response = await provider.chat(
                    messages=[Message(role=MessageRole.USER, content=self._build_user_payload(
                        reason=reason,
                        chat_id=chat_id,
                        session_key=session_key,
                        transcript=transcript,
                    ))],
                    system=self._build_system_prompt(),
                    max_tokens=1200,
                    temperature=0,
                )
                payload = self._parse_payload(str(response.message.content or ""))
            except Exception as exc:
                logger.warning("Reflection loop provider call failed", exc_info=True)
                self._last_error = str(exc)
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "reflections_written": 0,
                    "error": str(exc),
                }
                self._last_status["last_result"] = result
                return result

            decision = self._normalize_decision(payload)
            reflections = self._normalize_reflections(payload)
            if decision["decision"] == "skip_reflection":
                result = {
                    "reason": reason,
                    "chat_id": chat_id,
                    "session_key": session_key,
                    "reflections_written": 0,
                    "why": decision["skip_reason"] or "provider_skip",
                }
                return self._record_skip(
                    result,
                    skip_reason=decision["skip_reason"] or "provider_skip",
                    started_at=started_at,
                    session_key=session_key,
                    fingerprint=transcript_fingerprint,
                )
            written_ids: list[str] = []
            for item in reflections[: self._max_reflections_per_run]:
                try:
                    artifact = self._artifact_store.append_reflection(item)
                except Exception:
                    logger.warning("Reflection loop failed to append reflection", exc_info=True)
                    continue
                written_ids.append(artifact.reflection_id)

            if written_ids:
                latest = self._artifact_store.list_reflections(limit=1)
                latest_item = latest[-1] if latest else {}
                self._artifact_store.replace_attention_state(
                    {
                        "updated_at": _dump_time(started_at),
                        "current_focus_kind": "reflection",
                        "current_focus_summary": str(latest_item.get("summary") or ""),
                        "top_priority_tags": list(latest_item.get("suggested_drive_tags") or []),
                        "reflection_stale": False,
                    }
                )
                if self._event_bus is not None:
                    self._event_bus.emit(
                        "reflection_written",
                        scope={
                            "chat_id": chat_id,
                            "session_key": session_key,
                        },
                        payload={
                            "reflection_ids": written_ids,
                            "count": len(written_ids),
                            "reason": reason,
                        },
                    )

            result = {
                "reason": reason,
                "chat_id": chat_id,
                "session_key": session_key,
                "reflections_written": len(written_ids),
                "reflection_ids": written_ids,
                "why": "ok" if written_ids else "no_reflections",
            }
            if written_ids:
                self._last_status["reflection_write_count"] = int(self._last_status.get("reflection_write_count") or 0) + 1
                self._last_status["consecutive_skip_count"] = 0
                self._last_status["last_skip_reason"] = ""
            else:
                self._last_status["reflection_skip_count"] = int(self._last_status.get("reflection_skip_count") or 0) + 1
                self._last_status["consecutive_skip_count"] = int(self._last_status.get("consecutive_skip_count") or 0) + 1
                self._last_status["last_skip_reason"] = "no_reflections"
            self._last_status["last_result"] = result
            self._last_status["last_success_at"] = _dump_time(started_at)
            self._last_status["last_evaluated_at"] = _dump_time(started_at)
            self._last_status["last_source_session_key"] = session_key
            self._last_status["last_source_fingerprint"] = transcript_fingerprint
            self._last_error = ""
            return result

    def _build_system_prompt(self) -> str:
        workspace = self._workspace_loader.load(include_memory_md=True, include_heartbeat=False)
        sections = [_REFLECTION_SYSTEM_PROMPT]
        if workspace.soul_md:
            sections.append(f"[Workspace: SOUL.md]\n{workspace.soul_md}")
        if workspace.identity_md:
            sections.append(f"[Workspace: IDENTITY.md]\n{workspace.identity_md}")
        if workspace.user_md:
            sections.append(f"[Workspace: USER.md]\n{workspace.user_md}")
        if workspace.memory_md:
            sections.append(f"[Workspace: MEMORY.md]\n{workspace.memory_md}")
        return "\n\n".join(section for section in sections if section).strip()

    def _build_user_payload(
        self,
        *,
        reason: str,
        chat_id: int,
        session_key: str,
        transcript: list[dict[str, str]],
    ) -> str:
        workspace = self._workspace_loader.load(include_memory_md=True, include_heartbeat=False)
        recent_daily = [
            {"path": name, "content": body[-2500:]}
            for name, body in workspace.daily_memory[:2]
        ]
        recent_reflections = self._artifact_store.list_reflections(limit=5)
        payload = {
            "current_time": _dump_time(datetime.now(UTC)),
            "trigger_reason": reason,
            "chat_id": int(chat_id),
            "session_key": session_key,
            "recent_transcript": transcript,
            "recent_daily_memory": recent_daily,
            "recent_reflections": [
                {
                    "reflection_id": str(item.get("reflection_id") or ""),
                    "timestamp": str(item.get("timestamp") or ""),
                    "kind": str(item.get("kind") or ""),
                    "summary": str(item.get("summary") or ""),
                    "suggested_drive_tags": list(item.get("suggested_drive_tags") or []),
                }
                for item in recent_reflections
            ],
            "shared_mind": {
                "mode": str(self._shared_mind_state.snapshot().get("mode") or "active"),
                "agenda": dict(self._shared_mind_state.snapshot().get("agenda") or {}),
                "attention": dict(self._shared_mind_state.snapshot().get("attention") or {}),
            },
        }
        return json.dumps(payload, ensure_ascii=False)

    def _load_recent_transcript(self, session_key: str) -> list[dict[str, str]]:
        cleaned = str(session_key or "").strip()
        if not cleaned:
            return []
        path = self._sessions_dir / f"{session_key_to_filename(cleaned)}.jsonl"
        rows = self._read_jsonl_tail(path, max_lines=max(8, self._max_messages * 2))
        return self._filter_source_messages(rows)[-self._max_messages :]

    @staticmethod
    def _read_jsonl_tail(path: Path, *, max_lines: int) -> list[dict[str, Any]]:
        tail: deque[str] = deque(maxlen=max(1, int(max_lines)))
        try:
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    raw = line.strip()
                    if raw:
                        tail.append(raw)
        except OSError:
            return []
        out: list[dict[str, Any]] = []
        for raw in tail:
            try:
                parsed = json.loads(raw)
            except Exception:
                continue
            if isinstance(parsed, dict):
                out.append(parsed)
        return out

    @staticmethod
    def _filter_source_messages(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for row in rows:
            message = row.get("message") if isinstance(row.get("message"), dict) else row
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "").strip().lower()
            if role not in {"user", "assistant"}:
                continue
            content = message.get("content")
            text = str(content or "").strip() if isinstance(content, str) else ""
            if not text:
                continue
            out.append({"role": role, "content": text})
        return out

    @staticmethod
    def _parse_payload(raw: str) -> dict[str, Any] | None:
        cleaned = _JSON_FENCE_RE.sub("", str(raw or "").strip()).strip()
        if not cleaned:
            return None
        try:
            payload = json.loads(cleaned)
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        payload.setdefault("reflections", [])
        return payload

    @staticmethod
    def _normalize_decision(payload: dict[str, Any] | None) -> dict[str, str]:
        if not isinstance(payload, dict):
            return {"decision": "skip_reflection", "skip_reason": "invalid_payload"}
        decision = str(payload.get("decision") or "").strip().lower()
        skip_reason = " ".join(str(payload.get("skip_reason") or "").split()).strip()
        if decision == "write_reflections":
            return {"decision": "write_reflections", "skip_reason": ""}
        if decision == "skip_reflection":
            return {"decision": "skip_reflection", "skip_reason": skip_reason}
        reflections = payload.get("reflections")
        if isinstance(reflections, list) and reflections:
            return {"decision": "write_reflections", "skip_reason": ""}
        return {"decision": "skip_reflection", "skip_reason": skip_reason or "no_reflections"}

    def _normalize_reflections(self, payload: dict[str, Any] | None) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        reflections = payload.get("reflections")
        if not isinstance(reflections, list):
            return []
        out: list[dict[str, Any]] = []
        for item in reflections:
            if not isinstance(item, dict):
                continue
            summary = " ".join(str(item.get("summary") or "").split()).strip()
            if not summary:
                continue
            out.append(
                {
                    "reflection_id": str(item.get("reflection_id") or "").strip() or None,
                    "timestamp": _dump_time(datetime.now(UTC)),
                    "kind": str(item.get("kind") or "insight").strip() or "insight",
                    "summary": summary,
                    "scope": {},
                    "evidence": [
                        " ".join(str(value).split()).strip()
                        for value in list(item.get("evidence") or [])
                        if " ".join(str(value).split()).strip()
                    ],
                    "importance": item.get("importance", 0.0),
                    "novelty": item.get("novelty", 0.0),
                    "actionability": item.get("actionability", 0.0),
                    "suggested_drive_tags": [
                        " ".join(str(value).split()).strip()
                        for value in list(item.get("suggested_drive_tags") or [])
                        if " ".join(str(value).split()).strip()
                    ],
                }
            )
        return out

    def _should_skip_for_unchanged_source(
        self,
        *,
        reason: str,
        session_key: str,
        transcript_fingerprint: str,
    ) -> bool:
        if not session_key or not transcript_fingerprint:
            return False
        last_session_key = str(self._last_status.get("last_source_session_key") or "")
        last_fingerprint = str(self._last_status.get("last_source_fingerprint") or "")
        if session_key != last_session_key or transcript_fingerprint != last_fingerprint:
            return False
        if reason in {"manual", "startup"}:
            return False
        if reason.startswith("event:"):
            event_type = reason.split(":", 1)[1]
            if event_type in {"memory_maintenance_completed", "followup_created", "followup_updated", "continuity_written"}:
                return False
        return True

    @staticmethod
    def _transcript_fingerprint(transcript: list[dict[str, str]]) -> str:
        if not transcript:
            return ""
        normalized = [
            {
                "role": str(row.get("role") or "").strip().lower(),
                "content": " ".join(str(row.get("content") or "").split()).strip(),
            }
            for row in transcript
        ]
        return json.dumps(normalized, ensure_ascii=False, sort_keys=True)

    def _record_skip(
        self,
        result: dict[str, Any],
        *,
        skip_reason: str,
        started_at: datetime,
        session_key: str,
        fingerprint: str,
    ) -> dict[str, Any]:
        self._last_status["reflection_skip_count"] = int(self._last_status.get("reflection_skip_count") or 0) + 1
        self._last_status["consecutive_skip_count"] = int(self._last_status.get("consecutive_skip_count") or 0) + 1
        self._last_status["last_skip_reason"] = str(skip_reason or "").strip()
        self._last_status["last_result"] = dict(result)
        self._last_status["last_success_at"] = _dump_time(started_at)
        self._last_status["last_evaluated_at"] = _dump_time(started_at)
        self._last_status["last_source_session_key"] = session_key
        self._last_status["last_source_fingerprint"] = fingerprint
        self._last_error = ""
        return result

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
