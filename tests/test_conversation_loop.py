from __future__ import annotations

import pytest

from drost.conversation_loop import ConversationLoop
from drost.loop_events import LoopEventBus


async def _wait_until(predicate, *, timeout: float = 1.5) -> None:
    import asyncio

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    assert predicate()


@pytest.mark.asyncio
async def test_conversation_loop_tracks_turn_lifecycle_from_events() -> None:
    bus = LoopEventBus()
    loop = ConversationLoop(event_bus=bus)

    await loop.start()
    try:
        bus.emit(
            "user_message_received",
            scope={"chat_id": 123, "session_key": "main:telegram:123__s_2026-03-10_10-00-00"},
            payload={"channel": "telegram"},
        )
        await _wait_until(lambda: loop.status()["in_flight_turns"] == 1)

        bus.emit(
            "assistant_turn_completed",
            scope={"chat_id": 123, "session_key": "main:telegram:123__s_2026-03-10_10-00-00"},
            payload={"provider": "anthropic"},
        )
        await _wait_until(lambda: loop.status()["in_flight_turns"] == 0)

        bus.emit(
            "session_switched",
            scope={"chat_id": 123, "session_key": "main:telegram:123__s_2026-03-10_11-00-00"},
            payload={"from_session_key": "main:telegram:123__s_2026-03-10_10-00-00"},
        )
        await _wait_until(lambda: loop.status()["last_event_type"] == "session_switched")
    finally:
        await loop.stop()

    status = loop.status()
    assert status["last_chat_id"] == 123
    assert status["last_session_key"] == "main:telegram:123__s_2026-03-10_11-00-00"
    assert status["last_user_message_at"]
    assert status["last_assistant_turn_at"]
    assert status["last_session_switch_at"]
