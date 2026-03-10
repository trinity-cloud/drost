from __future__ import annotations

import pytest

from drost.loop_manager import LoopManager
from drost.managed_loop import LoopPriority, LoopVisibility, ManagedRunnerLoop


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
