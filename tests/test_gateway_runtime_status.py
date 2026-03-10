from __future__ import annotations

from types import SimpleNamespace

from drost.gateway import Gateway


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


def test_gateway_runtime_status_payload_joins_loops_mind_and_events() -> None:
    gateway = Gateway.__new__(Gateway)
    gateway.settings = SimpleNamespace(idle_active_window_seconds=1200)
    gateway.loop_manager = _FakeLoopManager()
    gateway.shared_mind_state = _FakeMindState()
    gateway.loop_events = _FakeEvents()

    payload = Gateway._runtime_status_payload(gateway)

    assert payload["running"] is True
    assert payload["mode"] == "active"
    assert payload["focus"]["chat_id"] == 123
    assert payload["health"]["degraded"] is False
    assert payload["loop_health"]["running"] == 2
    assert payload["event_counts"]["assistant_turn_completed"] == 1
    assert payload["recent_events"][0]["type"] == "assistant_turn_completed"
    assert payload["subscriber_count"] == 3
