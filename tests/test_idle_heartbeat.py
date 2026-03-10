from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from drost.followups import FollowUpStore
from drost.idle_heartbeat import IdleHeartbeatRunner
from drost.idle_state import IdleStateStore


@pytest.mark.asyncio
async def test_idle_heartbeat_surfaces_due_followup_when_idle(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="CPAP fitting appointment",
        entity_refs=["people/migel"],
        source_excerpt="CPAP fitting appointment tomorrow at 11am",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.95,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now - timedelta(hours=2))

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "surface_follow_up"
    assert sent == [(8271705169, "How did the CPAP fitting go?")]
    item = followups.list_followups(chat_id=8271705169)[0]
    assert item["status"] == "surfaced"


@pytest.mark.asyncio
async def test_idle_heartbeat_suppresses_proactive_send_while_active(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    idle_state = IdleStateStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    sent: list[tuple[int, str]] = []

    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Deploy stability review",
        entity_refs=["projects/drost"],
        source_excerpt="check stability later",
        follow_up_prompt="Has the deployer-default startup path been stable?",
        due_at=(now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.88,
    )
    idle_state.mark_user_message(chat_id=8271705169, at=now)

    runner = IdleHeartbeatRunner(
        workspace_dir=tmp_path,
        followups=followups,
        idle_state=idle_state,
        send_message=lambda chat_id, message: _record_send(sent, chat_id, message),
        enabled=True,
        proactive_enabled=True,
        interval_seconds=1800,
        active_window_seconds=20 * 60,
        proactive_cooldown_seconds=3600,
    )

    result = await runner.run_once(reason="manual", now=now)

    assert result["decision"] == "noop"
    assert result["why"] == "active_mode"
    assert sent == []


async def _record_send(log: list[tuple[int, str]], chat_id: int, message: str) -> Any:
    log.append((chat_id, message))
    return {"ok": True}
