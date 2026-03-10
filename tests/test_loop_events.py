from __future__ import annotations

from drost.loop_events import LoopEventBus


def test_loop_event_bus_filters_and_bounds_subscriber_queues() -> None:
    bus = LoopEventBus(recent_limit=3, default_queue_size=2)
    matched = bus.subscribe(name="matched", event_types={"followup_created"}, max_queue_size=1)
    all_events = bus.subscribe(name="all")

    bus.emit("user_message_received", scope={"chat_id": 1}, payload={"channel": "telegram"})
    bus.emit("followup_created", scope={"chat_id": 1}, payload={"follow_up_id": "f1"})
    bus.emit("followup_created", scope={"chat_id": 1}, payload={"follow_up_id": "f2"})

    latest = matched.queue.get_nowait()
    assert latest.type == "followup_created"
    assert latest.payload["follow_up_id"] == "f2"
    assert matched.dropped_count == 1
    assert all_events.queue.qsize() == 2

    status = bus.status()
    assert status["event_counts"]["user_message_received"] == 1
    assert status["event_counts"]["followup_created"] == 2
    assert len(status["recent_events"]) == 3
    assert status["subscriptions"]["matched"]["dropped_count"] == 1
