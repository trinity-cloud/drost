from __future__ import annotations

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from drost.cognitive_artifacts import CognitiveArtifactStore


class SharedMindState:
    def __init__(
        self,
        workspace_dir: str | Path,
        *,
        cognitive_artifacts: CognitiveArtifactStore | None = None,
    ) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()
        self._cognitive_artifacts = cognitive_artifacts or CognitiveArtifactStore(self._workspace_dir)
        self._cognitive_artifacts.ensure_layout()
        self._state = self._load_initial_state()
        self._refresh_cognitive_summary()
        self._save()

    @property
    def path(self) -> Path:
        return self._workspace_dir / "state" / "shared-mind-state.json"

    @property
    def legacy_idle_path(self) -> Path:
        return self._workspace_dir / "state" / "idle-consciousness.json"

    def snapshot(self) -> dict[str, Any]:
        return deepcopy(self._state)

    def status(self, *, active_window_seconds: int, now: datetime | None = None) -> dict[str, Any]:
        self.refresh_mode(active_window_seconds=active_window_seconds, now=now)
        return self.snapshot()

    def refresh_mode(self, *, active_window_seconds: int, now: datetime | None = None) -> dict[str, Any]:
        moment = now or _utc_now()
        activity = self._state["activity"]
        previous_mode = str(self._state.get("mode") or "active")
        last_user = _parse_time(activity.get("last_user_message_at"))
        cooldown_until = _parse_time(activity.get("proactive_cooldown_until"))

        if last_user is not None and (moment - last_user).total_seconds() < max(60, int(active_window_seconds)):
            next_mode = "active"
            activity["entered_idle_at"] = None
        elif cooldown_until is not None and cooldown_until > moment:
            next_mode = "cooldown"
            if not activity.get("entered_idle_at"):
                activity["entered_idle_at"] = _dump_time(moment)
        else:
            next_mode = "idle"
            if not activity.get("entered_idle_at"):
                activity["entered_idle_at"] = _dump_time(moment)

        self._state["mode"] = next_mode
        self._state["mode_changed"] = previous_mode != next_mode
        self._state["updated_at"] = _dump_time(moment)
        self._refresh_cognitive_summary()
        self._save()
        return self.snapshot()

    def mark_user_message(
        self,
        *,
        chat_id: int,
        session_key: str | None = None,
        channel: str = "telegram",
        at: datetime | None = None,
    ) -> dict[str, Any]:
        moment = at or _utc_now()
        self._set_focus(chat_id=chat_id, session_key=session_key, channel=channel)
        self._state["mode"] = "active"
        self._state["mode_changed"] = False
        self._state["activity"]["last_user_message_at"] = _dump_time(moment)
        self._state["activity"]["entered_idle_at"] = None
        self._state["updated_at"] = _dump_time(moment)
        self._save()
        return self.snapshot()

    def mark_assistant_message(
        self,
        *,
        chat_id: int,
        session_key: str | None = None,
        channel: str = "telegram",
        at: datetime | None = None,
    ) -> dict[str, Any]:
        moment = at or _utc_now()
        self._set_focus(chat_id=chat_id, session_key=session_key, channel=channel)
        self._state["activity"]["last_assistant_message_at"] = _dump_time(moment)
        self._state["updated_at"] = _dump_time(moment)
        self._save()
        return self.snapshot()

    def note_heartbeat(self, *, at: datetime | None = None) -> dict[str, Any]:
        moment = at or _utc_now()
        self._state["activity"]["last_heartbeat_at"] = _dump_time(moment)
        self._state["updated_at"] = _dump_time(moment)
        self._save()
        return self.snapshot()

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
        moment = at or _utc_now()
        current = dict(self._state.get("heartbeat") or {})
        heartbeat = {
            "last_decision_at": _dump_time(moment),
            "last_decision": str(decision or "").strip(),
            "last_reason": str(reason or "").strip(),
            "last_follow_up_id": str(follow_up_id or "").strip(),
            "last_audit_id": str(audit_id or current.get("last_audit_id") or "").strip(),
            "last_trigger_reason": str(trigger_reason or "").strip(),
            "last_decision_class": str(decision_class or "").strip(),
            "last_importance": str(importance or "").strip(),
            "last_meaningful_decision_at": str(current.get("last_meaningful_decision_at") or ""),
            "last_meaningful_decision": str(current.get("last_meaningful_decision") or ""),
            "last_meaningful_reason": str(current.get("last_meaningful_reason") or ""),
            "last_meaningful_follow_up_id": str(current.get("last_meaningful_follow_up_id") or ""),
            "last_meaningful_audit_id": str(current.get("last_meaningful_audit_id") or ""),
            "surface_count": int(current.get("surface_count") or 0),
            "suppress_count": int(current.get("suppress_count") or 0),
            "ignore_count": int(current.get("ignore_count") or 0),
            "noop_active_mode_count": int(current.get("noop_active_mode_count") or 0),
            "noop_interval_count": int(current.get("noop_interval_count") or 0),
            "noop_no_due_count": int(current.get("noop_no_due_count") or 0),
        }
        normalized_class = str(decision_class or "").strip().lower()
        if normalized_class == "surface":
            heartbeat["surface_count"] = int(heartbeat["surface_count"]) + 1
        elif normalized_class == "suppress":
            heartbeat["suppress_count"] = int(heartbeat["suppress_count"]) + 1
        else:
            heartbeat["ignore_count"] = int(heartbeat["ignore_count"]) + 1

        counter_key = str(aggregate_counter or "").strip().lower()
        if counter_key == "active_mode":
            heartbeat["noop_active_mode_count"] = int(heartbeat["noop_active_mode_count"]) + 1
        elif counter_key == "interval_not_elapsed":
            heartbeat["noop_interval_count"] = int(heartbeat["noop_interval_count"]) + 1
        elif counter_key == "no_due_followups":
            heartbeat["noop_no_due_count"] = int(heartbeat["noop_no_due_count"]) + 1

        if meaningful:
            heartbeat["last_meaningful_decision_at"] = _dump_time(moment)
            heartbeat["last_meaningful_decision"] = str(decision or "").strip()
            heartbeat["last_meaningful_reason"] = str(reason or "").strip()
            heartbeat["last_meaningful_follow_up_id"] = str(follow_up_id or "").strip()
            if audit_id:
                heartbeat["last_meaningful_audit_id"] = str(audit_id).strip()

        self._state["heartbeat"] = heartbeat
        self._state["updated_at"] = _dump_time(moment)
        self._save()
        return self.snapshot()

    def note_proactive_surface(
        self,
        *,
        chat_id: int,
        session_key: str | None = None,
        channel: str = "telegram",
        at: datetime | None = None,
        cooldown_seconds: int = 6 * 60 * 60,
    ) -> dict[str, Any]:
        moment = at or _utc_now()
        self._set_focus(chat_id=chat_id, session_key=session_key, channel=channel)
        self._state["mode"] = "cooldown"
        self._state["mode_changed"] = False
        self._state["activity"]["last_assistant_message_at"] = _dump_time(moment)
        self._state["activity"]["last_proactive_surface_at"] = _dump_time(moment)
        self._state["activity"]["proactive_cooldown_until"] = _dump_time(
            moment + timedelta(seconds=max(60, int(cooldown_seconds)))
        )
        if not self._state["activity"].get("entered_idle_at"):
            self._state["activity"]["entered_idle_at"] = _dump_time(moment)
        self._state["updated_at"] = _dump_time(moment)
        self._save()
        return self.snapshot()

    def set_loop_states(self, loop_states: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(loop_states, dict):
            return self.snapshot()
        self._state["loop_state"] = deepcopy(loop_states)
        self._state["updated_at"] = _dump_time(_utc_now())
        self._refresh_cognitive_summary()
        self._save()
        return self.snapshot()

    def set_health(self, *, degraded: bool, last_error: str = "") -> dict[str, Any]:
        self._state["health"] = {
            "degraded": bool(degraded),
            "last_error": str(last_error or ""),
        }
        self._state["updated_at"] = _dump_time(_utc_now())
        self._refresh_cognitive_summary()
        self._save()
        return self.snapshot()

    def proactive_gate(
        self,
        *,
        active_window_seconds: int,
        chat_id: int,
        session_key: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        state = self.status(active_window_seconds=active_window_seconds, now=now)
        health = state.get("health") if isinstance(state.get("health"), dict) else {}
        if bool(health.get("degraded")):
            return {"allowed": False, "reason": "degraded_mode", "state": state}

        focus = state.get("focus") if isinstance(state.get("focus"), dict) else {}
        focus_chat_id = int(focus.get("chat_id") or 0)
        focus_session_key = str(focus.get("session_key") or "").strip()
        target_session_key = str(session_key or "").strip()
        if focus_chat_id > 0 and int(chat_id) > 0 and focus_chat_id != int(chat_id):
            return {"allowed": False, "reason": "focus_mismatch", "state": state}
        if target_session_key and focus_session_key and target_session_key != focus_session_key:
            return {"allowed": False, "reason": "session_mismatch", "state": state}

        mode = str(state.get("mode") or "active")
        if mode == "active":
            return {"allowed": False, "reason": "active_mode", "state": state}
        if mode == "cooldown":
            return {"allowed": False, "reason": "cooldown", "state": state}
        return {"allowed": True, "reason": "idle", "state": state}

    def to_idle_view(self, *, active_window_seconds: int, now: datetime | None = None) -> dict[str, Any]:
        state = self.status(active_window_seconds=active_window_seconds, now=now)
        focus = dict(state.get("focus") or {})
        activity = dict(state.get("activity") or {})
        return {
            "version": int(state.get("version") or 1),
            "mode": str(state.get("mode") or "active"),
            "mode_changed": bool(state.get("mode_changed")),
            "active_chat_id": int(focus.get("chat_id") or 0),
            "active_session_key": str(focus.get("session_key") or ""),
            "channel": str(focus.get("channel") or ""),
            "last_user_message_at": activity.get("last_user_message_at") or "",
            "last_assistant_message_at": activity.get("last_assistant_message_at") or "",
            "entered_idle_at": activity.get("entered_idle_at"),
            "last_heartbeat_at": activity.get("last_heartbeat_at"),
            "last_proactive_surface_at": activity.get("last_proactive_surface_at"),
            "proactive_cooldown_until": activity.get("proactive_cooldown_until"),
        }

    def overwrite_from_idle_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._normalize_state(self._convert_legacy_idle_payload(payload))
        self._state = state
        self._save()
        return self.snapshot()

    def _set_focus(self, *, chat_id: int, session_key: str | None, channel: str) -> None:
        current = dict(self._state.get("focus") or {})
        existing_chat_id = int(current.get("chat_id") or 0)
        self._state["focus"] = {
            "chat_id": int(chat_id),
            "session_key": self._resolve_session_key(chat_id=chat_id, session_key=session_key, existing_chat_id=existing_chat_id),
            "channel": str(channel or current.get("channel") or "telegram"),
        }

    def _resolve_session_key(self, *, chat_id: int, session_key: str | None, existing_chat_id: int) -> str:
        cleaned = str(session_key or "").strip()
        if cleaned:
            return cleaned
        current = dict(self._state.get("focus") or {})
        if existing_chat_id == int(chat_id):
            return str(current.get("session_key") or "")
        return ""

    def _load_initial_state(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                payload = {}
            return self._normalize_state(payload)
        if self.legacy_idle_path.exists():
            try:
                payload = json.loads(self.legacy_idle_path.read_text(encoding="utf-8"))
            except Exception:
                payload = {}
            return self._normalize_state(self._convert_legacy_idle_payload(payload))
        return self._default_state()

    def _normalize_state(self, payload: Any) -> dict[str, Any]:
        raw = payload if isinstance(payload, dict) else {}
        focus = raw.get("focus") if isinstance(raw.get("focus"), dict) else {}
        activity = raw.get("activity") if isinstance(raw.get("activity"), dict) else {}
        health = raw.get("health") if isinstance(raw.get("health"), dict) else {}
        loop_state = raw.get("loop_state") if isinstance(raw.get("loop_state"), dict) else {}
        reflection = raw.get("reflection") if isinstance(raw.get("reflection"), dict) else {}
        agenda = raw.get("agenda") if isinstance(raw.get("agenda"), dict) else {}
        attention = raw.get("attention") if isinstance(raw.get("attention"), dict) else {}
        initiatives = raw.get("initiatives") if isinstance(raw.get("initiatives"), dict) else {}
        heartbeat = raw.get("heartbeat") if isinstance(raw.get("heartbeat"), dict) else {}
        return {
            "version": int(raw.get("version") or 2),
            "mode": str(raw.get("mode") or "active"),
            "mode_changed": bool(raw.get("mode_changed")),
            "focus": {
                "chat_id": int(focus.get("chat_id") or 0),
                "session_key": str(focus.get("session_key") or ""),
                "channel": str(focus.get("channel") or "telegram"),
            },
            "activity": {
                "last_user_message_at": str(activity.get("last_user_message_at") or ""),
                "last_assistant_message_at": str(activity.get("last_assistant_message_at") or ""),
                "entered_idle_at": activity.get("entered_idle_at"),
                "last_heartbeat_at": activity.get("last_heartbeat_at"),
                "last_proactive_surface_at": activity.get("last_proactive_surface_at"),
                "proactive_cooldown_until": activity.get("proactive_cooldown_until"),
            },
            "loop_state": deepcopy(loop_state),
            "health": {
                "degraded": bool(health.get("degraded", False)),
                "last_error": str(health.get("last_error") or ""),
            },
            "reflection": {
                "path": str(reflection.get("path") or ""),
                "count": int(reflection.get("count") or 0),
                "last_reflection_at": str(reflection.get("last_reflection_at") or ""),
                "last_high_importance_reflection_id": str(reflection.get("last_high_importance_reflection_id") or ""),
                "recent_themes": [
                    str(item).strip()
                    for item in list(reflection.get("recent_themes") or [])
                    if str(item).strip()
                ],
            },
            "agenda": {
                "path": str(agenda.get("path") or ""),
                "active_count": int(agenda.get("active_count") or 0),
                "last_drive_update_at": str(agenda.get("last_drive_update_at") or ""),
                "top_items": [
                    dict(item)
                    for item in list(agenda.get("top_items") or [])
                    if isinstance(item, dict)
                ],
            },
            "attention": {
                "path": str(attention.get("path") or ""),
                "current_focus_kind": str(attention.get("current_focus_kind") or "conversation"),
                "current_focus_summary": str(attention.get("current_focus_summary") or ""),
                "top_priority_tags": [
                    str(item).strip()
                    for item in list(attention.get("top_priority_tags") or [])
                    if str(item).strip()
                ],
                "reflection_stale": bool(attention.get("reflection_stale", False)),
                "drive_stale": bool(attention.get("drive_stale", False)),
                "last_updated_at": str(attention.get("last_updated_at") or ""),
            },
            "initiatives": {
                "path": str(initiatives.get("path") or ""),
                "active_count": int(initiatives.get("active_count") or 0),
                "last_updated_at": str(initiatives.get("last_updated_at") or ""),
                "top_items": [
                    dict(item)
                    for item in list(initiatives.get("top_items") or [])
                    if isinstance(item, dict)
                ],
            },
            "heartbeat": {
                "last_decision_at": str(heartbeat.get("last_decision_at") or ""),
                "last_decision": str(heartbeat.get("last_decision") or ""),
                "last_reason": str(heartbeat.get("last_reason") or ""),
                "last_follow_up_id": str(heartbeat.get("last_follow_up_id") or ""),
                "last_audit_id": str(heartbeat.get("last_audit_id") or ""),
                "last_trigger_reason": str(heartbeat.get("last_trigger_reason") or ""),
                "last_decision_class": str(heartbeat.get("last_decision_class") or ""),
                "last_importance": str(heartbeat.get("last_importance") or ""),
                "last_meaningful_decision_at": str(heartbeat.get("last_meaningful_decision_at") or ""),
                "last_meaningful_decision": str(heartbeat.get("last_meaningful_decision") or ""),
                "last_meaningful_reason": str(heartbeat.get("last_meaningful_reason") or ""),
                "last_meaningful_follow_up_id": str(heartbeat.get("last_meaningful_follow_up_id") or ""),
                "last_meaningful_audit_id": str(heartbeat.get("last_meaningful_audit_id") or ""),
                "surface_count": int(heartbeat.get("surface_count") or 0),
                "suppress_count": int(heartbeat.get("suppress_count") or 0),
                "ignore_count": int(heartbeat.get("ignore_count") or 0),
                "noop_active_mode_count": int(heartbeat.get("noop_active_mode_count") or 0),
                "noop_interval_count": int(heartbeat.get("noop_interval_count") or 0),
                "noop_no_due_count": int(heartbeat.get("noop_no_due_count") or 0),
            },
            "updated_at": str(raw.get("updated_at") or ""),
        }

    @staticmethod
    def _convert_legacy_idle_payload(payload: Any) -> dict[str, Any]:
        raw = payload if isinstance(payload, dict) else {}
        return {
            "version": int(raw.get("version") or 1),
            "mode": str(raw.get("mode") or "active"),
            "mode_changed": bool(raw.get("mode_changed")),
            "focus": {
                "chat_id": int(raw.get("active_chat_id") or 0),
                "session_key": str(raw.get("active_session_key") or ""),
                "channel": str(raw.get("channel") or "telegram"),
            },
            "activity": {
                "last_user_message_at": str(raw.get("last_user_message_at") or ""),
                "last_assistant_message_at": str(raw.get("last_assistant_message_at") or ""),
                "entered_idle_at": raw.get("entered_idle_at"),
                "last_heartbeat_at": raw.get("last_heartbeat_at"),
                "last_proactive_surface_at": raw.get("last_proactive_surface_at"),
                "proactive_cooldown_until": raw.get("proactive_cooldown_until"),
            },
            "loop_state": {},
            "health": {
                "degraded": False,
                "last_error": "",
            },
            "updated_at": str(raw.get("updated_at") or ""),
        }

    @staticmethod
    def _default_state() -> dict[str, Any]:
        return {
            "version": 2,
            "mode": "active",
            "mode_changed": False,
            "focus": {
                "chat_id": 0,
                "session_key": "",
                "channel": "telegram",
            },
            "activity": {
                "last_user_message_at": "",
                "last_assistant_message_at": "",
                "entered_idle_at": None,
                "last_heartbeat_at": None,
                "last_proactive_surface_at": None,
                "proactive_cooldown_until": None,
            },
            "loop_state": {},
            "health": {
                "degraded": False,
                "last_error": "",
            },
            "reflection": {
                "path": "",
                "count": 0,
                "last_reflection_at": "",
                "last_high_importance_reflection_id": "",
                "recent_themes": [],
            },
            "agenda": {
                "path": "",
                "active_count": 0,
                "last_drive_update_at": "",
                "top_items": [],
            },
            "attention": {
                "path": "",
                "current_focus_kind": "conversation",
                "current_focus_summary": "",
                "top_priority_tags": [],
                "reflection_stale": False,
                "drive_stale": False,
                "last_updated_at": "",
            },
            "initiatives": {
                "path": "",
                "active_count": 0,
                "last_updated_at": "",
                "top_items": [],
            },
            "heartbeat": {
                "last_decision_at": "",
                "last_decision": "",
                "last_reason": "",
                "last_follow_up_id": "",
                "last_audit_id": "",
                "last_trigger_reason": "",
                "last_decision_class": "",
                "last_importance": "",
                "last_meaningful_decision_at": "",
                "last_meaningful_decision": "",
                "last_meaningful_reason": "",
                "last_meaningful_follow_up_id": "",
                "last_meaningful_audit_id": "",
                "surface_count": 0,
                "suppress_count": 0,
                "ignore_count": 0,
                "noop_active_mode_count": 0,
                "noop_interval_count": 0,
                "noop_no_due_count": 0,
            },
            "updated_at": "",
        }

    def _refresh_cognitive_summary(self) -> None:
        summary = self._cognitive_artifacts.summary()
        self._state["reflection"] = dict(summary.get("reflection") or {})
        self._state["agenda"] = dict(summary.get("agenda") or {})
        self._state["attention"] = dict(summary.get("attention") or {})
        self._state["initiatives"] = dict(summary.get("initiatives") or {})

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)


def _utc_now() -> datetime:
    return datetime.now(UTC)


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
