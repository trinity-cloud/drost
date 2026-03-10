from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

OPEN_STATUSES = {"pending", "surfaced", "snoozed"}
SURFACE_CANDIDATE_STATUSES = {"pending", "snoozed"}
_PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}


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


def _normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _normalize_subject(value: str) -> str:
    return _normalize_space(value).casefold()


def _normalize_entity_ref(value: str) -> str:
    cleaned = _normalize_space(value)
    if "/" not in cleaned:
        return cleaned.casefold()
    entity_type, entity_id = cleaned.split("/", 1)
    left = re.sub(r"\s+", "-", entity_type.strip().casefold())
    right = re.sub(r"\s+", "-", entity_id.strip().casefold())
    return f"{left}/{right}".strip("/")


class FollowUpStore:
    def __init__(self, workspace_dir: str | Path) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()

    @property
    def followups_path(self) -> Path:
        return self._workspace_dir / "memory" / "follow-ups.json"

    @property
    def responsibilities_path(self) -> Path:
        return self._workspace_dir / "memory" / "responsibilities.json"

    def ensure_layout(self) -> None:
        self.followups_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.followups_path.exists():
            self._save_payload(self.followups_path, {"version": 1, "items": []})
        if not self.responsibilities_path.exists():
            self._save_payload(self.responsibilities_path, {"version": 1, "items": []})

    def _load_payload(self, path: Path) -> dict[str, Any]:
        self.ensure_layout()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            payload = {"version": 1, "items": []}
        if not isinstance(payload, dict):
            return {"version": 1, "items": []}
        items = payload.get("items")
        if not isinstance(items, list):
            payload["items"] = []
        payload.setdefault("version", 1)
        return payload

    def _save_payload(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)

    def list_followups(self, *, chat_id: int | None = None) -> list[dict[str, Any]]:
        payload = self._load_payload(self.followups_path)
        items = payload.get("items") if isinstance(payload, dict) else []
        out: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if chat_id is not None and int(item.get("chat_id") or 0) != int(chat_id):
                continue
            out.append(dict(item))
        out.sort(key=self._sort_key)
        return out

    def list_due(self, *, now: datetime | None = None, chat_id: int | None = None, limit: int = 5) -> list[dict[str, Any]]:
        moment = now or _utc_now()
        candidates: list[dict[str, Any]] = []
        for item in self.list_followups(chat_id=chat_id):
            status = str(item.get("status") or "pending").strip().lower()
            if status not in SURFACE_CANDIDATE_STATUSES:
                continue
            due_at = _parse_time(item.get("due_at"))
            if due_at is None or due_at > moment:
                continue
            not_before = _parse_time(item.get("not_before"))
            if not_before is not None and not_before > moment:
                continue
            suppress_until = _parse_time(item.get("suppress_until"))
            if suppress_until is not None and suppress_until > moment:
                continue
            candidates.append(item)
        candidates.sort(key=self._sort_key)
        return candidates[: max(1, int(limit))]

    def list_relevant(
        self,
        *,
        now: datetime | None = None,
        chat_id: int | None = None,
        limit: int = 5,
        lookahead_hours: int = 72,
    ) -> list[dict[str, Any]]:
        moment = now or _utc_now()
        horizon = moment + timedelta(hours=max(1, int(lookahead_hours)))
        out: list[dict[str, Any]] = []
        for item in self.list_followups(chat_id=chat_id):
            status = str(item.get("status") or "pending").strip().lower()
            if status not in OPEN_STATUSES:
                continue
            due_at = _parse_time(item.get("due_at"))
            if due_at is None:
                continue
            if due_at > horizon:
                continue
            out.append(item)
        out.sort(key=self._sort_key)
        return out[: max(1, int(limit))]

    def upsert_extracted_followup(
        self,
        *,
        chat_id: int,
        source_session_key: str,
        kind: str,
        subject: str,
        entity_refs: list[str],
        source_excerpt: str,
        follow_up_prompt: str,
        due_at: str,
        not_before: str | None = None,
        priority: str = "medium",
        confidence: float | None = None,
        notes: str | None = None,
        source: str | None = None,
    ) -> tuple[dict[str, Any], bool]:
        cleaned_subject = _normalize_space(subject)
        cleaned_prompt = _normalize_space(follow_up_prompt)
        due_time = _parse_time(due_at)
        if int(chat_id) <= 0:
            raise ValueError("chat_id must be positive")
        if not str(source_session_key or "").strip():
            raise ValueError("source_session_key is required")
        if not cleaned_subject:
            raise ValueError("subject is required")
        if not cleaned_prompt:
            raise ValueError("follow_up_prompt is required")
        if due_time is None:
            raise ValueError("due_at must be a valid ISO timestamp")

        not_before_time = _parse_time(not_before)
        now = _utc_now()
        payload = self._load_payload(self.followups_path)
        items = payload.setdefault("items", [])
        assert isinstance(items, list)

        canonical_refs = sorted({_normalize_entity_ref(ref) for ref in entity_refs if _normalize_entity_ref(ref)})
        priority_value = str(priority or "medium").strip().lower() or "medium"
        if priority_value not in _PRIORITY_ORDER:
            priority_value = "medium"

        match = self._find_match(
            items,
            chat_id=int(chat_id),
            subject=cleaned_subject,
            due_at=due_time,
            entity_refs=canonical_refs,
        )
        if match is not None:
            merged_refs = sorted({*canonical_refs, *[_normalize_entity_ref(value) for value in (match.get("entity_refs") or [])]})
            match.update(
                {
                    "kind": str(kind or "check_in").strip() or "check_in",
                    "subject": cleaned_subject,
                    "entity_refs": [ref for ref in merged_refs if ref],
                    "source_session_key": str(source_session_key).strip(),
                    "source_excerpt": _normalize_space(source_excerpt),
                    "follow_up_prompt": cleaned_prompt,
                    "due_at": _dump_time(due_time),
                    "not_before": _dump_time(not_before_time),
                    "priority": priority_value,
                    "confidence": None if confidence is None else float(confidence),
                    "notes": _normalize_space(notes or "") or None,
                    "source": _normalize_space(source or "") or None,
                    "updated_at": _dump_time(now),
                }
            )
            self._save_payload(self.followups_path, payload)
            return dict(match), False

        item_id = self._next_followup_id(items, now=now)
        item = {
            "id": item_id,
            "kind": str(kind or "check_in").strip() or "check_in",
            "chat_id": int(chat_id),
            "subject": cleaned_subject,
            "entity_refs": canonical_refs,
            "source_session_key": str(source_session_key).strip(),
            "source_excerpt": _normalize_space(source_excerpt),
            "follow_up_prompt": cleaned_prompt,
            "due_at": _dump_time(due_time),
            "not_before": _dump_time(not_before_time),
            "priority": priority_value,
            "confidence": None if confidence is None else float(confidence),
            "status": "pending",
            "created_at": _dump_time(now),
            "updated_at": _dump_time(now),
            "completed_at": None,
            "dismissed_at": None,
            "last_surfaced_at": None,
            "suppress_until": None,
            "notes": _normalize_space(notes or "") or None,
            "source": _normalize_space(source or "") or None,
        }
        items.append(item)
        self._save_payload(self.followups_path, payload)
        return dict(item), True

    def mark_surfaced(
        self,
        followup_id: str,
        *,
        surfaced_at: datetime | None = None,
        suppress_for_seconds: int = 6 * 60 * 60,
    ) -> dict[str, Any] | None:
        return self._update_status(
            followup_id,
            status="surfaced",
            last_surfaced_at=_dump_time(surfaced_at or _utc_now()),
            suppress_until=_dump_time((surfaced_at or _utc_now()) + timedelta(seconds=max(60, int(suppress_for_seconds)))),
        )

    def snooze(self, followup_id: str, *, until: datetime) -> dict[str, Any] | None:
        return self._update_status(
            followup_id,
            status="snoozed",
            suppress_until=_dump_time(until),
        )

    def mark_completed(self, followup_id: str) -> dict[str, Any] | None:
        return self._update_status(
            followup_id,
            status="completed",
            completed_at=_dump_time(_utc_now()),
            suppress_until=None,
        )

    def dismiss(self, followup_id: str) -> dict[str, Any] | None:
        return self._update_status(
            followup_id,
            status="dismissed",
            dismissed_at=_dump_time(_utc_now()),
            suppress_until=None,
        )

    def expire(self, followup_id: str) -> dict[str, Any] | None:
        return self._update_status(
            followup_id,
            status="expired",
            suppress_until=None,
        )

    def _update_status(self, followup_id: str, **updates: Any) -> dict[str, Any] | None:
        payload = self._load_payload(self.followups_path)
        items = payload.setdefault("items", [])
        assert isinstance(items, list)
        for item in items:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "") != str(followup_id or ""):
                continue
            item.update(updates)
            item["updated_at"] = _dump_time(_utc_now())
            self._save_payload(self.followups_path, payload)
            return dict(item)
        return None

    @staticmethod
    def _find_match(
        items: list[Any],
        *,
        chat_id: int,
        subject: str,
        due_at: datetime,
        entity_refs: list[str],
    ) -> dict[str, Any] | None:
        normalized_subject = _normalize_subject(subject)
        due_day = due_at.date().isoformat()
        ref_set = set(entity_refs)
        for raw in items:
            if not isinstance(raw, dict):
                continue
            status = str(raw.get("status") or "pending").strip().lower()
            if status not in OPEN_STATUSES:
                continue
            if int(raw.get("chat_id") or 0) != int(chat_id):
                continue
            if _normalize_subject(str(raw.get("subject") or "")) != normalized_subject:
                continue
            existing_due = _parse_time(raw.get("due_at"))
            if existing_due is None or existing_due.date().isoformat() != due_day:
                continue
            existing_refs = {
                _normalize_entity_ref(value)
                for value in (raw.get("entity_refs") or [])
                if _normalize_entity_ref(str(value))
            }
            if ref_set and existing_refs and ref_set.isdisjoint(existing_refs):
                continue
            return raw
        return None

    @staticmethod
    def _next_followup_id(items: list[Any], *, now: datetime) -> str:
        prefix = f"followup_{now.date().isoformat().replace('-', '_')}_"
        max_n = 0
        for raw in items:
            if not isinstance(raw, dict):
                continue
            item_id = str(raw.get("id") or "")
            if not item_id.startswith(prefix):
                continue
            suffix = item_id[len(prefix) :]
            try:
                max_n = max(max_n, int(suffix))
            except ValueError:
                continue
        return f"{prefix}{max_n + 1:04d}"

    @staticmethod
    def _sort_key(item: dict[str, Any]) -> tuple[int, str, str, str]:
        priority = _PRIORITY_ORDER.get(str(item.get("priority") or "medium").strip().lower(), 1)
        due_at = _dump_time(_parse_time(item.get("due_at")) or _utc_now()) or ""
        created_at = _dump_time(_parse_time(item.get("created_at")) or _utc_now()) or ""
        return priority, due_at, created_at, str(item.get("id") or "")
