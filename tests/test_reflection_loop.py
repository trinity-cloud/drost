from __future__ import annotations

import json
from pathlib import Path

import pytest

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.loop_events import LoopEventBus
from drost.providers.base import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta
from drost.reflection_loop import ReflectionLoop
from drost.shared_mind_state import SharedMindState
from drost.storage.keys import session_key_to_filename


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
            "reflections": [
                {
                    "kind": "pattern",
                    "summary": "Migel prefers precise mechanistic explanations.",
                    "evidence": ["session tail"],
                    "importance": 0.9,
                    "novelty": 0.7,
                    "actionability": 0.8,
                    "suggested_drive_tags": ["health", "communication"],
                }
            ]
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


def _write_session(session_dir: Path, session_key: str) -> None:
    session_dir.mkdir(parents=True, exist_ok=True)
    path = session_dir / f"{session_key_to_filename(session_key)}.jsonl"
    rows = [
        {
            "message": {
                "role": "user",
                "content": "I need you to explain this precisely, not vaguely.",
            }
        },
        {
            "message": {
                "role": "assistant",
                "content": "Understood. I’ll keep it mechanistic and concrete.",
            }
        },
    ]
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


@pytest.mark.asyncio
async def test_reflection_loop_writes_artifact_and_emits_event(tmp_path: Path) -> None:
    session_key = "main:telegram:123__s_2026-03-10_22-00-00"
    _write_session(tmp_path / "sessions", session_key)

    artifacts = CognitiveArtifactStore(tmp_path)
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    events = LoopEventBus()
    loop = ReflectionLoop(
        workspace_dir=tmp_path,
        sessions_dir=tmp_path / "sessions",
        provider_getter=lambda: _FakeProvider(),
        shared_mind_state=shared,
        event_bus=events,
        artifact_store=artifacts,
        interval_seconds=1800,
    )

    result = await loop.run_once(
        reason="manual",
        event_scope={"chat_id": 123, "session_key": session_key},
    )

    summary = artifacts.summary()
    attention = artifacts.load_attention_state()

    assert result["reflections_written"] == 1
    assert summary["reflection"]["count"] == 1
    assert summary["reflection"]["recent_themes"] == ["health", "communication"]
    assert attention["current_focus_kind"] == "reflection"
    assert events.status()["event_counts"]["reflection_written"] == 1


@pytest.mark.asyncio
async def test_reflection_loop_noops_without_recent_transcript(tmp_path: Path) -> None:
    artifacts = CognitiveArtifactStore(tmp_path)
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    loop = ReflectionLoop(
        workspace_dir=tmp_path,
        sessions_dir=tmp_path / "sessions",
        provider_getter=lambda: _FakeProvider(),
        shared_mind_state=shared,
        event_bus=None,
        artifact_store=artifacts,
    )

    result = await loop.run_once(
        reason="manual",
        event_scope={"chat_id": 123, "session_key": "main:telegram:123__s_missing"},
    )

    assert result["reflections_written"] == 0
    assert result["why"] == "no_recent_transcript"
