from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from drost.idle_state import IdleStateStore


def test_idle_state_transitions_between_active_idle_and_cooldown(tmp_path: Path) -> None:
    store = IdleStateStore(tmp_path)
    start = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)

    store.mark_user_message(chat_id=8271705169, at=start)
    active = store.refresh(active_window_seconds=20 * 60, now=start + timedelta(minutes=5))
    assert active["mode"] == "active"

    idle = store.refresh(active_window_seconds=20 * 60, now=start + timedelta(minutes=25))
    assert idle["mode"] == "idle"
    assert idle["entered_idle_at"]

    cooldown = store.note_proactive_surface(chat_id=8271705169, at=start + timedelta(minutes=26), cooldown_seconds=3600)
    assert cooldown["mode"] == "cooldown"

    still_cooldown = store.refresh(active_window_seconds=20 * 60, now=start + timedelta(minutes=40))
    assert still_cooldown["mode"] == "cooldown"

    back_to_active = store.mark_user_message(chat_id=8271705169, at=start + timedelta(minutes=41))
    assert back_to_active["mode"] == "active"
