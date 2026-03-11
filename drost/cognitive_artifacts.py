from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
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


def _dump_time(value: datetime | None) -> str:
    if value is None:
        return ""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _normalize_space(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def _normalize_list(values: list[Any] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in values or []:
        cleaned = _normalize_space(str(raw or ""))
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def _clamp_score(value: Any) -> float:
    try:
        score = float(value)
    except Exception:
        return 0.0
    if score < 0.0:
        return 0.0
    if score > 1.0:
        return 1.0
    return score


@dataclass(slots=True, frozen=True)
class ReflectionArtifact:
    reflection_id: str
    timestamp: str
    kind: str
    summary: str
    scope: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    importance: float = 0.0
    novelty: float = 0.0
    actionability: float = 0.0
    suggested_drive_tags: list[str] = field(default_factory=list)
    expires_at: str | None = None

    @classmethod
    def from_input(cls, value: ReflectionArtifact | dict[str, Any]) -> ReflectionArtifact:
        if isinstance(value, ReflectionArtifact):
            return value
        raw = dict(value or {})
        timestamp = _dump_time(_parse_time(raw.get("timestamp")) or _utc_now())
        reflection_id = _normalize_space(raw.get("reflection_id") or "") or f"refl_{uuid.uuid4().hex[:12]}"
        return cls(
            reflection_id=reflection_id,
            timestamp=timestamp,
            kind=_normalize_space(raw.get("kind") or "insight") or "insight",
            summary=_normalize_space(raw.get("summary") or ""),
            scope=dict(raw.get("scope") or {}),
            evidence=_normalize_list(raw.get("evidence")),
            importance=_clamp_score(raw.get("importance")),
            novelty=_clamp_score(raw.get("novelty")),
            actionability=_clamp_score(raw.get("actionability")),
            suggested_drive_tags=_normalize_list(raw.get("suggested_drive_tags")),
            expires_at=_dump_time(_parse_time(raw.get("expires_at"))) or None,
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True, frozen=True)
class DriveAgendaItem:
    drive_id: str
    title: str
    summary: str
    kind: str = "open_thread"
    status: str = "active"
    priority: float = 0.0
    urgency: float = 0.0
    confidence: float = 0.0
    recommended_channel: str = "hold"
    source_refs: list[str] = field(default_factory=list)
    next_review_at: str | None = None

    @classmethod
    def from_input(cls, value: DriveAgendaItem | dict[str, Any]) -> DriveAgendaItem:
        if isinstance(value, DriveAgendaItem):
            return value
        raw = dict(value or {})
        drive_id = _normalize_space(raw.get("drive_id") or "") or f"drv_{uuid.uuid4().hex[:12]}"
        return cls(
            drive_id=drive_id,
            title=_normalize_space(raw.get("title") or ""),
            summary=_normalize_space(raw.get("summary") or ""),
            kind=_normalize_space(raw.get("kind") or "open_thread") or "open_thread",
            status=_normalize_space(raw.get("status") or "active") or "active",
            priority=_clamp_score(raw.get("priority")),
            urgency=_clamp_score(raw.get("urgency")),
            confidence=_clamp_score(raw.get("confidence")),
            recommended_channel=_normalize_space(raw.get("recommended_channel") or "hold") or "hold",
            source_refs=_normalize_list(raw.get("source_refs")),
            next_review_at=_dump_time(_parse_time(raw.get("next_review_at"))) or None,
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True, frozen=True)
class DriveStateSnapshot:
    updated_at: str
    generated_at: str
    active_items: list[DriveAgendaItem] = field(default_factory=list)
    completed_items: list[DriveAgendaItem] = field(default_factory=list)
    suppressed_items: list[DriveAgendaItem] = field(default_factory=list)

    @classmethod
    def from_input(cls, value: DriveStateSnapshot | dict[str, Any]) -> DriveStateSnapshot:
        if isinstance(value, DriveStateSnapshot):
            return value
        raw = dict(value or {})
        generated_at = _dump_time(_parse_time(raw.get("generated_at")) or _utc_now())
        updated_at = _dump_time(_parse_time(raw.get("updated_at")) or _utc_now())
        return cls(
            updated_at=updated_at,
            generated_at=generated_at,
            active_items=[DriveAgendaItem.from_input(item) for item in list(raw.get("active_items") or [])],
            completed_items=[DriveAgendaItem.from_input(item) for item in list(raw.get("completed_items") or [])],
            suppressed_items=[DriveAgendaItem.from_input(item) for item in list(raw.get("suppressed_items") or [])],
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "updated_at": self.updated_at,
            "generated_at": self.generated_at,
            "active_items": [item.as_dict() for item in self.active_items],
            "completed_items": [item.as_dict() for item in self.completed_items],
            "suppressed_items": [item.as_dict() for item in self.suppressed_items],
        }


@dataclass(slots=True, frozen=True)
class AttentionStateSnapshot:
    updated_at: str
    current_focus_kind: str = "conversation"
    current_focus_summary: str = ""
    top_priority_tags: list[str] = field(default_factory=list)
    reflection_stale: bool = False
    drive_stale: bool = False

    @classmethod
    def from_input(cls, value: AttentionStateSnapshot | dict[str, Any]) -> AttentionStateSnapshot:
        if isinstance(value, AttentionStateSnapshot):
            return value
        raw = dict(value or {})
        return cls(
            updated_at=_dump_time(_parse_time(raw.get("updated_at")) or _utc_now()),
            current_focus_kind=_normalize_space(raw.get("current_focus_kind") or "conversation") or "conversation",
            current_focus_summary=_normalize_space(raw.get("current_focus_summary") or ""),
            top_priority_tags=_normalize_list(raw.get("top_priority_tags")),
            reflection_stale=bool(raw.get("reflection_stale", False)),
            drive_stale=bool(raw.get("drive_stale", False)),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "updated_at": self.updated_at,
            "current_focus_kind": self.current_focus_kind,
            "current_focus_summary": self.current_focus_summary,
            "top_priority_tags": list(self.top_priority_tags),
            "reflection_stale": bool(self.reflection_stale),
            "drive_stale": bool(self.drive_stale),
        }


class CognitiveArtifactStore:
    def __init__(self, workspace_dir: str | Path) -> None:
        self._workspace_dir = Path(workspace_dir).expanduser()

    @property
    def state_dir(self) -> Path:
        return self._workspace_dir / "state"

    @property
    def reflections_path(self) -> Path:
        return self.state_dir / "reflections.jsonl"

    @property
    def drive_state_path(self) -> Path:
        return self.state_dir / "drive-state.json"

    @property
    def attention_state_path(self) -> Path:
        return self.state_dir / "attention-state.json"

    def ensure_layout(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if not self.reflections_path.exists():
            self.reflections_path.write_text("", encoding="utf-8")
        if not self.drive_state_path.exists():
            self._save_json(
                self.drive_state_path,
                DriveStateSnapshot.from_input({}).as_dict(),
            )
        if not self.attention_state_path.exists():
            self._save_json(
                self.attention_state_path,
                AttentionStateSnapshot.from_input({}).as_dict(),
            )

    def append_reflection(self, value: ReflectionArtifact | dict[str, Any]) -> ReflectionArtifact:
        self.ensure_layout()
        artifact = ReflectionArtifact.from_input(value)
        if not artifact.summary:
            raise ValueError("reflection summary is required")
        with self.reflections_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(artifact.as_dict(), ensure_ascii=False) + "\n")
        return artifact

    def list_reflections(self, *, limit: int | None = None) -> list[dict[str, Any]]:
        self.ensure_layout()
        rows: list[dict[str, Any]] = []
        for line in self.reflections_path.read_text(encoding="utf-8").splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            try:
                payload = json.loads(cleaned)
            except Exception:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
        if limit is not None and limit > 0:
            return rows[-int(limit) :]
        return rows

    def replace_drive_state(self, value: DriveStateSnapshot | dict[str, Any]) -> dict[str, Any]:
        self.ensure_layout()
        snapshot = DriveStateSnapshot.from_input(value)
        payload = snapshot.as_dict()
        self._save_json(self.drive_state_path, payload)
        return payload

    def load_drive_state(self) -> dict[str, Any]:
        self.ensure_layout()
        return self._load_json(self.drive_state_path, DriveStateSnapshot.from_input({}).as_dict())

    def replace_attention_state(self, value: AttentionStateSnapshot | dict[str, Any]) -> dict[str, Any]:
        self.ensure_layout()
        snapshot = AttentionStateSnapshot.from_input(value)
        payload = snapshot.as_dict()
        self._save_json(self.attention_state_path, payload)
        return payload

    def load_attention_state(self) -> dict[str, Any]:
        self.ensure_layout()
        return self._load_json(self.attention_state_path, AttentionStateSnapshot.from_input({}).as_dict())

    def summary(self) -> dict[str, Any]:
        self.ensure_layout()
        reflections = self.list_reflections()
        drive_state = self.load_drive_state()
        attention_state = self.load_attention_state()

        last_reflection_at = ""
        last_high_importance_reflection_id = ""
        recent_themes: list[str] = []
        if reflections:
            last_reflection = reflections[-1]
            last_reflection_at = str(last_reflection.get("timestamp") or "")
            for item in reversed(reflections):
                if _clamp_score(item.get("importance")) >= 0.75:
                    last_high_importance_reflection_id = str(item.get("reflection_id") or "")
                    break
            seen_tags: set[str] = set()
            for item in reversed(reflections[-12:]):
                for raw in list(item.get("suggested_drive_tags") or []):
                    cleaned = _normalize_space(raw)
                    if not cleaned or cleaned in seen_tags:
                        continue
                    seen_tags.add(cleaned)
                    recent_themes.append(cleaned)
                    if len(recent_themes) >= 5:
                        break
                if len(recent_themes) >= 5:
                    break

        active_items = [
            DriveAgendaItem.from_input(item)
            for item in list(drive_state.get("active_items") or [])
        ]
        top_items = sorted(
            active_items,
            key=lambda item: (-float(item.priority), -float(item.urgency), item.title.casefold()),
        )[:3]

        return {
            "reflection": {
                "path": str(self.reflections_path),
                "count": len(reflections),
                "last_reflection_at": last_reflection_at,
                "last_high_importance_reflection_id": last_high_importance_reflection_id,
                "recent_themes": recent_themes,
            },
            "agenda": {
                "path": str(self.drive_state_path),
                "active_count": len(active_items),
                "last_drive_update_at": str(drive_state.get("updated_at") or ""),
                "top_items": [
                    {
                        "drive_id": item.drive_id,
                        "title": item.title,
                        "kind": item.kind,
                        "priority": item.priority,
                        "recommended_channel": item.recommended_channel,
                    }
                    for item in top_items
                ],
            },
            "attention": {
                "path": str(self.attention_state_path),
                "current_focus_kind": str(attention_state.get("current_focus_kind") or "conversation"),
                "current_focus_summary": str(attention_state.get("current_focus_summary") or ""),
                "top_priority_tags": list(attention_state.get("top_priority_tags") or []),
                "reflection_stale": bool(attention_state.get("reflection_stale", False)),
                "drive_stale": bool(attention_state.get("drive_stale", False)),
                "last_updated_at": str(attention_state.get("updated_at") or ""),
            },
        }

    @staticmethod
    def _load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            payload = dict(default)
        return payload if isinstance(payload, dict) else dict(default)

    @staticmethod
    def _save_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
