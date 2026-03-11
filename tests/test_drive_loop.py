from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.drive_loop import DriveLoop
from drost.followups import FollowUpStore
from drost.loop_events import LoopEventBus
from drost.providers.base import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta
from drost.shared_mind_state import SharedMindState


class _FakeProvider(BaseProvider):
    @property
    def name(self) -> str:
        return "fake"

    @property
    def model(self) -> str:
        return "fake-model"

    async def chat(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ) -> ChatResponse:
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        payload = {
            "active_items": [
                {
                    "drive_id": "drv_docs",
                    "title": "Tighten Drost docs",
                    "summary": "README and operator docs still need polish.",
                    "kind": "open_thread",
                    "status": "active",
                    "priority": 0.92,
                    "urgency": 0.61,
                    "confidence": 0.88,
                    "recommended_channel": "conversation_only",
                    "source_refs": ["refl_docs", "fu_20260311_0001"],
                }
            ],
            "completed_items": [],
            "suppressed_items": [],
            "attention": {
                "current_focus_kind": "drive",
                "current_focus_summary": "Keep documentation and operator surfaces aligned.",
                "top_priority_tags": ["docs", "runtime"],
                "reflection_stale": False,
                "drive_stale": False,
            },
        }
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=json.dumps(payload)),
            finish_reason="stop",
        )

    async def chat_stream(
        self,
        messages: list[Message],
        *,
        system: str | None = None,
        tools: list[object] | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        stop_sequences: list[str] | None = None,
    ):
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        if False:
            yield StreamDelta()
        return


@pytest.mark.asyncio
async def test_drive_loop_writes_agenda_and_emits_event(tmp_path: Path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    artifacts.append_reflection(
        {
            "reflection_id": "refl_docs",
            "timestamp": "2026-03-11T01:00:00Z",
            "kind": "pattern",
            "summary": "The docs are drifting behind the runtime shape.",
            "importance": 0.9,
            "novelty": 0.5,
            "actionability": 0.8,
            "suggested_drive_tags": ["docs", "runtime"],
        }
    )
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    followups = FollowUpStore(tmp_path)
    followups.upsert_extracted_followup(
        chat_id=123,
        source_session_key="main:telegram:123__s_2026-03-11_01-00-00",
        kind="check_in",
        subject="README polish",
        entity_refs=["projects/drost"],
        source_excerpt="The docs need one more cleanup pass.",
        follow_up_prompt="Do the docs still need cleanup?",
        due_at=(datetime.now(UTC) + timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
        priority="medium",
        confidence=0.8,
    )
    events = LoopEventBus()
    loop = DriveLoop(
        workspace_dir=tmp_path,
        provider_getter=lambda: _FakeProvider(),
        shared_mind_state=shared,
        followups=followups,
        artifact_store=artifacts,
        event_bus=events,
        interval_seconds=1800,
    )

    result = await loop.run_once(
        reason="manual",
        event_scope={"chat_id": 123, "session_key": "main:telegram:123__s_2026-03-11_01-00-00"},
    )

    drive_state = artifacts.load_drive_state()
    attention = artifacts.load_attention_state()
    summary = artifacts.summary()

    assert result["agenda_items_written"] == 1
    assert result["drive_ids"] == ["drv_docs"]
    assert drive_state["active_items"][0]["title"] == "Tighten Drost docs"
    assert drive_state["active_items"][0]["recommended_channel"] == "conversation_only"
    assert summary["agenda"]["active_count"] == 1
    assert summary["agenda"]["top_items"][0]["drive_id"] == "drv_docs"
    assert attention["current_focus_kind"] == "drive"
    assert attention["top_priority_tags"] == ["docs", "runtime"]
    assert events.status()["event_counts"]["drive_updated"] == 1


@pytest.mark.asyncio
async def test_drive_loop_noops_without_inputs(tmp_path: Path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    followups = FollowUpStore(tmp_path)
    loop = DriveLoop(
        workspace_dir=tmp_path,
        provider_getter=lambda: _FakeProvider(),
        shared_mind_state=shared,
        followups=followups,
        artifact_store=artifacts,
        event_bus=None,
    )

    result = await loop.run_once(reason="manual", event_scope={"chat_id": 123})

    assert result["agenda_items_written"] == 0
    assert result["why"] == "no_inputs"
