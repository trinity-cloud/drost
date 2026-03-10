from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from drost.followups import FollowUpStore


def test_followup_store_upserts_and_lists_due(tmp_path: Path) -> None:
    store = FollowUpStore(tmp_path)
    due_at = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)

    first, created_first = store.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="CPAP fitting appointment",
        entity_refs=["people/Migel", "projects/Health"],
        source_excerpt="CPAP fitting appointment tomorrow at 11am",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=due_at.isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.96,
        source="main_telegram_8271705169__s_2026-03-09_10-00-00.jsonl:1",
    )
    second, created_second = store.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="CPAP fitting appointment",
        entity_refs=["people/migel"],
        source_excerpt="same obligation restated",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at=due_at.isoformat().replace("+00:00", "Z"),
        priority="high",
        confidence=0.97,
        source="main_telegram_8271705169__s_2026-03-09_10-00-00.jsonl:2",
    )

    assert created_first is True
    assert created_second is False
    assert first["id"] == second["id"]

    due = store.list_due(now=due_at + timedelta(hours=1), chat_id=8271705169)
    assert len(due) == 1
    assert due[0]["subject"] == "CPAP fitting appointment"
    assert due[0]["entity_refs"] == ["people/migel", "projects/health"]


def test_followup_store_marks_surfaced_and_suppresses_repeats(tmp_path: Path) -> None:
    store = FollowUpStore(tmp_path)
    now = datetime(2026, 3, 9, 12, 0, tzinfo=UTC)
    item, _ = store.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-09_10-00-00",
        kind="check_in",
        subject="Deploy stability review",
        entity_refs=["projects/drost"],
        source_excerpt="Check deploy stability tomorrow",
        follow_up_prompt="Has the deployer-default startup path been stable?",
        due_at=now.isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.9,
    )

    store.mark_surfaced(item["id"], surfaced_at=now, suppress_for_seconds=3600)

    assert store.list_due(now=now + timedelta(minutes=30), chat_id=8271705169) == []
    due_again = store.list_due(now=now + timedelta(hours=2), chat_id=8271705169)
    assert due_again == []

    all_items = store.list_followups(chat_id=8271705169)
    assert all_items[0]["status"] == "surfaced"
