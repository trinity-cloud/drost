from __future__ import annotations

import json
from types import SimpleNamespace

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.gateway import Gateway
from drost.quality_gates import QualityGateEvaluator


class _FakeLoopManager:
    def status(self) -> dict[str, object]:
        return {
            "running": True,
            "loop_count": 2,
            "loop_names": ["conversation_loop", "heartbeat_loop"],
            "last_started_at": "2026-03-10T20:00:00Z",
            "last_stopped_at": "",
            "last_error": "",
            "degraded": False,
            "degraded_reason": "",
            "proactive_action_in_flight": False,
            "proactive_action_owner": "",
            "last_proactive_action_at": "",
            "last_proactive_action_reason": "",
            "loop_health": {"running": 2, "failed": 0, "stopped": 0, "registered": 0},
            "failed_loops": [],
            "loops": {
                "conversation_loop": {
                    "name": "conversation_loop",
                    "state": "running",
                    "last_event_type": "assistant_turn_completed",
                },
                "heartbeat_loop": {
                    "name": "heartbeat_loop",
                    "state": "running",
                    "last_trigger_event": "assistant_turn_completed",
                },
            },
        }


class _FakeMindState:
    def status(self, *, active_window_seconds: int) -> dict[str, object]:
        assert active_window_seconds == 1200
        return {
            "mode": "active",
            "focus": {"chat_id": 123, "session_key": "main:telegram:123__s_2026-03-10_20-00-00", "channel": "telegram"},
            "activity": {"last_user_message_at": "2026-03-10T20:01:00Z"},
            "health": {"degraded": False, "last_error": ""},
            "reflection": {"count": 2, "last_reflection_at": "2026-03-10T20:02:00Z"},
            "agenda": {"active_count": 1, "top_items": [{"drive_id": "drv_1"}]},
            "attention": {"current_focus_kind": "conversation"},
            "heartbeat": {"last_decision": "noop", "last_audit_id": "hba_test"},
        }


class _FakeEvents:
    def status(self) -> dict[str, object]:
        return {
            "total_emitted": 7,
            "event_counts": {"assistant_turn_completed": 1, "user_message_received": 1},
            "subscriber_count": 3,
            "subscriptions": {"conversation_loop": {"delivered_count": 2}},
            "recent_events": [{"type": "assistant_turn_completed"}],
        }


def test_gateway_runtime_status_payload_joins_loops_mind_and_events(tmp_path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    artifacts.append_reflection(
        {
            "reflection_id": "refl_a",
            "timestamp": "2026-03-10T20:02:00Z",
            "kind": "pattern",
            "summary": "Deploy validation is still too weak.",
            "importance": 0.9,
        }
    )
    artifacts.replace_drive_state(
        {
            "active_items": [
                {
                    "drive_id": "drv_1",
                    "title": "Strengthen deploy canary",
                    "summary": "Health endpoint alone is weak.",
                    "priority": 0.9,
                }
            ]
        }
    )
    audit_path = tmp_path / "state" / "heartbeat-decisions.jsonl"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(
        (
            json.dumps({"audit_id": "hba_old", "decision": "noop", "reason": "active_mode"})
            + "\n"
            + json.dumps(
                {
                    "audit_id": "hba_test",
                    "decision": "noop",
                    "decision_class": "suppress",
                    "importance": "normal",
                    "reason": "drive_prefers_hold",
                }
            )
            + "\n"
        ),
        encoding="utf-8",
    )

    gateway = Gateway.__new__(Gateway)
    gateway.settings = SimpleNamespace(idle_active_window_seconds=1200)
    gateway.loop_manager = _FakeLoopManager()
    gateway.shared_mind_state = _FakeMindState()
    gateway.loop_events = _FakeEvents()
    gateway.cognitive_artifacts = artifacts
    gateway.idle_heartbeat = SimpleNamespace(audit_path=audit_path)
    gateway.quality_gates = QualityGateEvaluator(tmp_path)

    payload = Gateway._runtime_status_payload(gateway)

    assert payload["running"] is True
    assert payload["mode"] == "active"
    assert payload["focus"]["chat_id"] == 123
    assert payload["health"]["degraded"] is False
    assert payload["reflection"]["count"] == 2
    assert payload["agenda"]["active_count"] == 1
    assert payload["attention"]["current_focus_kind"] == "conversation"
    assert payload["heartbeat"]["last_decision"] == "noop"
    assert payload["loop_health"]["running"] == 2
    assert payload["event_counts"]["assistant_turn_completed"] == 1
    assert payload["recent_events"][0]["type"] == "assistant_turn_completed"
    assert payload["subscriber_count"] == 3
    assert payload["cognition"]["recent_reflections"][0]["reflection_id"] == "refl_a"
    assert payload["cognition"]["active_agenda_items"][0]["drive_id"] == "drv_1"
    assert len(payload["cognition"]["recent_heartbeat_decisions"]) == 1
    assert payload["cognition"]["recent_heartbeat_decisions"][0]["audit_id"] == "hba_test"
    assert payload["quality"]["overall_state"] in {"pending", "fail", "pass"}
