from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.shared_mind_state import SharedMindState


def test_shared_mind_state_persists_focus_and_activity_across_reload(tmp_path: Path) -> None:
    state = SharedMindState(tmp_path)
    start = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)

    state.mark_user_message(
        chat_id=8271705169,
        session_key="main:telegram:8271705169__s_2026-03-10_10-00-00",
        at=start,
    )
    state.note_proactive_surface(
        chat_id=8271705169,
        session_key="main:telegram:8271705169__s_2026-03-10_10-00-00",
        at=start + timedelta(minutes=30),
        cooldown_seconds=3600,
    )
    state.set_loop_states({"heartbeat_loop": {"state": "running"}})

    reloaded = SharedMindState(tmp_path)
    snapshot = reloaded.snapshot()

    assert snapshot["focus"]["chat_id"] == 8271705169
    assert snapshot["focus"]["session_key"] == "main:telegram:8271705169__s_2026-03-10_10-00-00"
    assert snapshot["activity"]["last_proactive_surface_at"]
    assert snapshot["loop_state"]["heartbeat_loop"]["state"] == "running"
    assert reloaded.path.exists()


def test_shared_mind_state_migrates_legacy_idle_state(tmp_path: Path) -> None:
    legacy_path = tmp_path / "state" / "idle-consciousness.json"
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_payload = {
        "version": 1,
        "mode": "cooldown",
        "active_chat_id": 8271705169,
        "active_session_key": "main:telegram:8271705169__s_2026-03-10_10-00-00",
        "channel": "telegram",
        "last_user_message_at": "2026-03-10T11:00:00Z",
        "last_assistant_message_at": "2026-03-10T11:05:00Z",
        "entered_idle_at": "2026-03-10T11:30:00Z",
        "last_heartbeat_at": "2026-03-10T11:35:00Z",
        "last_proactive_surface_at": "2026-03-10T11:40:00Z",
        "proactive_cooldown_until": "2026-03-10T13:40:00Z",
    }
    legacy_path.write_text(json.dumps(legacy_payload), encoding="utf-8")

    state = SharedMindState(tmp_path)
    snapshot = state.snapshot()

    assert snapshot["mode"] == "cooldown"
    assert snapshot["focus"]["chat_id"] == 8271705169
    assert snapshot["focus"]["session_key"] == legacy_payload["active_session_key"]
    assert snapshot["activity"]["last_heartbeat_at"] == legacy_payload["last_heartbeat_at"]
    assert state.path.exists()
    migrated = json.loads(state.path.read_text(encoding="utf-8"))
    assert migrated["focus"]["chat_id"] == 8271705169


def test_shared_mind_state_includes_cognitive_artifact_summary(tmp_path: Path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    artifacts.append_reflection(
        {
            "reflection_id": "refl_x",
            "timestamp": "2026-03-10T22:00:00Z",
            "kind": "insight",
            "summary": "Deploy validation remains a live concern.",
            "importance": 0.92,
            "suggested_drive_tags": ["self_mod", "ops"],
        }
    )
    artifacts.replace_drive_state(
        {
            "updated_at": "2026-03-10T22:10:00Z",
            "generated_at": "2026-03-10T22:09:00Z",
            "active_items": [
                {
                    "drive_id": "drv_x",
                    "title": "Strengthen deploy canary",
                    "summary": "Health endpoint alone is weak.",
                    "priority": 0.91,
                    "kind": "concern",
                    "recommended_channel": "conversation_only",
                }
            ],
        }
    )
    artifacts.replace_attention_state(
        {
            "updated_at": "2026-03-10T22:11:00Z",
            "current_focus_kind": "reflection",
            "current_focus_summary": "Reviewing deploy safety themes.",
            "top_priority_tags": ["self_mod"],
        }
    )

    state = SharedMindState(tmp_path)
    snapshot = state.status(active_window_seconds=1200)

    assert snapshot["reflection"]["count"] == 1
    assert snapshot["reflection"]["last_high_importance_reflection_id"] == "refl_x"
    assert snapshot["agenda"]["active_count"] == 1
    assert snapshot["agenda"]["top_items"][0]["drive_id"] == "drv_x"
    assert snapshot["attention"]["current_focus_kind"] == "reflection"
