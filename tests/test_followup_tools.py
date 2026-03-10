from __future__ import annotations

from pathlib import Path

from drost.followups import FollowUpStore
from drost.tools.followup_status import FollowUpStatusTool
from drost.tools.followup_update import FollowUpUpdateTool


async def test_followup_status_tool_lists_due_items(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-10_10-00-00",
        kind="check_in",
        subject="CPAP fitting appointment",
        entity_refs=["people/migel"],
        source_excerpt="CPAP appointment tomorrow at 11am",
        follow_up_prompt="How did the CPAP fitting go?",
        due_at="2026-03-10T19:00:00Z",
        priority="high",
        confidence=0.95,
    )

    tool = FollowUpStatusTool(followups=followups, current_chat_id=lambda: 8271705169)
    text = await tool.execute(limit=5)

    assert "Follow-ups for chat_id=8271705169" in text
    assert "CPAP fitting appointment" in text
    assert "How did the CPAP fitting go?" in text


async def test_followup_update_tool_completes_item(tmp_path: Path) -> None:
    followups = FollowUpStore(tmp_path)
    item, _ = followups.upsert_extracted_followup(
        chat_id=8271705169,
        source_session_key="main:telegram:8271705169__s_2026-03-10_10-00-00",
        kind="check_in",
        subject="Deploy stability review",
        entity_refs=["projects/drost"],
        source_excerpt="Check deploy stability later",
        follow_up_prompt="Has the deployer-default startup path been stable?",
        due_at="2026-03-10T19:00:00Z",
        priority="medium",
        confidence=0.88,
    )

    tool = FollowUpUpdateTool(followups=followups, current_chat_id=lambda: 8271705169)
    text = await tool.execute(followup_id=str(item["id"]), action="complete")

    assert "followup_updated=true" in text
    assert "status=completed" in text
    assert followups.list_followups(chat_id=8271705169)[0]["status"] == "completed"
