from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


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


class IdleStateStore:
    def __init__(self, workspace_dir: str | Path) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()

    @property
    def path(self) -> Path:
        return self._workspace_dir / "state" / "idle-consciousness.json"

    def ensure(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._save(
                {
                    "version": 1,
                    "mode": "active",
                    "active_chat_id": 0,
                    "last_user_message_at": "",
                    "last_assistant_message_at": "",
                    "entered_idle_at": None,
                    "last_heartbeat_at": None,
                    "last_proactive_surface_at": None,
                    "proactive_cooldown_until": None,
                }
            )

    def load(self) -> dict[str, Any]:
        self.ensure()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        payload.setdefault("version", 1)
        payload.setdefault("mode", "active")
        payload.setdefault("active_chat_id", 0)
        payload.setdefault("last_user_message_at", "")
        payload.setdefault("last_assistant_message_at", "")
        payload.setdefault("entered_idle_at", None)
        payload.setdefault("last_heartbeat_at", None)
        payload.setdefault("last_proactive_surface_at", None)
        payload.setdefault("proactive_cooldown_until", None)
        return payload

    def save(self, payload: dict[str, Any]) -> None:
        self.ensure()
        self._save(payload)

    def _save(self, payload: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(self.path)

    def mark_user_message(self, *, chat_id: int, at: datetime | None = None) -> dict[str, Any]:
        moment = at or _utc_now()
        payload = self.load()
        payload["mode"] = "active"
        payload["active_chat_id"] = int(chat_id)
        payload["last_user_message_at"] = _dump_time(moment)
        payload["entered_idle_at"] = None
        self.save(payload)
        return payload

    def mark_assistant_message(self, *, chat_id: int, at: datetime | None = None) -> dict[str, Any]:
        moment = at or _utc_now()
        payload = self.load()
        payload["active_chat_id"] = int(chat_id)
        payload["last_assistant_message_at"] = _dump_time(moment)
        self.save(payload)
        return payload

    def note_heartbeat(self, *, at: datetime | None = None) -> dict[str, Any]:
        moment = at or _utc_now()
        payload = self.load()
        payload["last_heartbeat_at"] = _dump_time(moment)
        self.save(payload)
        return payload

    def note_proactive_surface(
        self,
        *,
        chat_id: int,
        at: datetime | None = None,
        cooldown_seconds: int = 6 * 60 * 60,
    ) -> dict[str, Any]:
        moment = at or _utc_now()
        payload = self.load()
        payload["active_chat_id"] = int(chat_id)
        payload["mode"] = "cooldown"
        payload["last_assistant_message_at"] = _dump_time(moment)
        payload["last_proactive_surface_at"] = _dump_time(moment)
        payload["proactive_cooldown_until"] = _dump_time(moment + timedelta(seconds=max(60, int(cooldown_seconds))))
        if not payload.get("entered_idle_at"):
            payload["entered_idle_at"] = _dump_time(moment)
        self.save(payload)
        return payload

    def refresh(self, *, active_window_seconds: int, now: datetime | None = None) -> dict[str, Any]:
        moment = now or _utc_now()
        payload = self.load()
        last_user = _parse_time(payload.get("last_user_message_at"))
        cooldown_until = _parse_time(payload.get("proactive_cooldown_until"))
        previous_mode = str(payload.get("mode") or "active")

        if last_user is not None and (moment - last_user).total_seconds() < max(60, int(active_window_seconds)):
            next_mode = "active"
            payload["entered_idle_at"] = None
        elif cooldown_until is not None and cooldown_until > moment:
            next_mode = "cooldown"
            if not payload.get("entered_idle_at"):
                payload["entered_idle_at"] = _dump_time(moment)
        else:
            next_mode = "idle"
            if not payload.get("entered_idle_at"):
                payload["entered_idle_at"] = _dump_time(moment)

        payload["mode"] = next_mode
        payload["mode_changed"] = previous_mode != next_mode
        self.save(payload)
        return payload

    def status(self, *, active_window_seconds: int) -> dict[str, Any]:
        return self.refresh(active_window_seconds=active_window_seconds)
