from __future__ import annotations

from datetime import UTC, datetime

import pytest

from drost.loop_manager import LoopManager
from drost.managed_loop import LoopPriority, LoopVisibility, ManagedRunnerLoop
from drost.shared_mind_state import SharedMindState


@pytest.mark.asyncio
async def test_loop_manager_starts_by_priority_and_stops_in_reverse() -> None:
    events: list[str] = []

    async def _start_high() -> None:
        events.append("start:high")

    async def _stop_high() -> None:
        events.append("stop:high")

    async def _start_low() -> None:
        events.append("start:low")

    async def _stop_low() -> None:
        events.append("stop:low")

    manager = LoopManager()
    manager.register(
        ManagedRunnerLoop(
            name="low_loop",
            priority=LoopPriority.LOW,
            visibility=LoopVisibility.BACKGROUND,
            start_fn=_start_low,
            stop_fn=_stop_low,
            status_fn=lambda: {"enabled": True},
        )
    )
    manager.register(
        ManagedRunnerLoop(
            name="high_loop",
            priority=LoopPriority.HIGH,
            visibility=LoopVisibility.FOREGROUND,
            start_fn=_start_high,
            stop_fn=_stop_high,
            status_fn=lambda: {"enabled": True},
        )
    )

    await manager.start()
    await manager.stop()

    assert events == ["start:high", "start:low", "stop:low", "stop:high"]


@pytest.mark.asyncio
async def test_loop_manager_rejects_duplicate_names() -> None:
    async def _noop() -> None:
        return None

    manager = LoopManager()
    loop = ManagedRunnerLoop(
        name="dup_loop",
        priority=LoopPriority.NORMAL,
        visibility=LoopVisibility.BACKGROUND,
        start_fn=_noop,
        stop_fn=_noop,
        status_fn=lambda: {},
    )
    manager.register(loop)

    with pytest.raises(ValueError, match="already registered"):
        manager.register(loop)


@pytest.mark.asyncio
async def test_loop_manager_status_aggregates_loop_metadata() -> None:
    async def _noop() -> None:
        return None

    manager = LoopManager()
    manager.register(
        ManagedRunnerLoop(
            name="maintenance_loop",
            priority=LoopPriority.LOW,
            visibility=LoopVisibility.BACKGROUND,
            start_fn=_noop,
            stop_fn=_noop,
            status_fn=lambda: {"enabled": True, "running": False},
        )
    )

    await manager.start()
    status = manager.status()

    assert status["running"] is True
    assert status["loop_count"] == 1
    assert status["loop_names"] == ["maintenance_loop"]
    assert status["loops"]["maintenance_loop"]["state"] == "running"
    assert status["loops"]["maintenance_loop"]["enabled"] is True


@pytest.mark.asyncio
async def test_loop_manager_proactive_gate_uses_shared_state_and_single_flight(tmp_path) -> None:
    shared = SharedMindState(tmp_path)
    manager = LoopManager(shared_mind_state=shared, active_window_seconds=20 * 60)

    async def _noop() -> None:
        return None

    conversation_state = {"in_flight_turns": 0}
    manager.register(
        ManagedRunnerLoop(
            name="conversation_loop",
            priority=LoopPriority.FOREGROUND,
            visibility=LoopVisibility.FOREGROUND,
            start_fn=_noop,
            stop_fn=_noop,
            status_fn=lambda: dict(conversation_state),
        )
    )
    await manager.start()

    shared.mark_user_message(chat_id=123)
    blocked = manager.proactive_gate(chat_id=123, session_key="")
    assert blocked["allowed"] is False
    assert blocked["reason"] == "active_mode"

    shared.mark_user_message(chat_id=123, at=datetime(2026, 3, 10, 12, 0, tzinfo=UTC))
    allowed = manager.proactive_gate(
        chat_id=123,
        session_key="",
        now=datetime(2026, 3, 10, 14, 30, tzinfo=UTC),
    )
    assert allowed["allowed"] is True

    claim = manager.begin_proactive_action(chat_id=123, session_key="", owner="heartbeat_loop")
    assert claim["allowed"] is True
    inflight = manager.proactive_gate(
        chat_id=123,
        session_key="",
        now=datetime(2026, 3, 10, 14, 31, tzinfo=UTC),
    )
    assert inflight["allowed"] is False
    assert inflight["reason"] == "proactive_in_flight"
    manager.finish_proactive_action(owner="heartbeat_loop", reason="completed")

    conversation_state["in_flight_turns"] = 1
    busy = manager.proactive_gate(
        chat_id=123,
        session_key="",
        now=datetime(2026, 3, 10, 14, 32, tzinfo=UTC),
    )
    assert busy["allowed"] is False
    assert busy["reason"] == "conversation_in_flight"


@pytest.mark.asyncio
async def test_loop_manager_mark_degraded_updates_status_and_shared_health(tmp_path) -> None:
    shared = SharedMindState(tmp_path)
    manager = LoopManager(shared_mind_state=shared)

    manager.mark_degraded("heartbeat send failed")
    status = manager.status()
    assert status["degraded"] is True
    assert status["degraded_reason"] == "heartbeat send failed"
    assert shared.snapshot()["health"]["degraded"] is True

    manager.clear_degraded()
    assert manager.status()["degraded"] is False
    assert shared.snapshot()["health"]["degraded"] is False
