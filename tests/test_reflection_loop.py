from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from drost.cognitive_artifacts import CognitiveArtifactStore
from drost.loop_events import LoopEventBus
from drost.providers.base import BaseProvider, ChatResponse, Message, MessageRole, StreamDelta
from drost.reflection_loop import ReflectionLoop
from drost.shared_mind_state import SharedMindState
from drost.storage.keys import session_key_to_filename


class _FakeProvider(BaseProvider):
    def __init__(self, payload: dict[str, object] | None = None) -> None:
        self._payload = payload or {
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
        self.chat_calls = 0

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
        self.chat_calls += 1
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=json.dumps(self._payload)),
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


@pytest.mark.asyncio
async def test_reflection_loop_respects_provider_skip_decision(tmp_path: Path) -> None:
    session_key = "main:telegram:123__s_2026-03-10_22-00-00"
    _write_session(tmp_path / "sessions", session_key)

    provider = _FakeProvider(
        {
            "decision": "skip_reflection",
            "skip_reason": "no_new_information",
            "reflections": [],
        }
    )
    artifacts = CognitiveArtifactStore(tmp_path)
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    loop = ReflectionLoop(
        workspace_dir=tmp_path,
        sessions_dir=tmp_path / "sessions",
        provider_getter=lambda: provider,
        shared_mind_state=shared,
        event_bus=None,
        artifact_store=artifacts,
        interval_seconds=1800,
    )

    result = await loop.run_once(
        reason="manual",
        event_scope={"chat_id": 123, "session_key": session_key},
    )

    status = loop.status()
    assert result["reflections_written"] == 0
    assert result["why"] == "no_new_information"
    assert artifacts.summary()["reflection"]["count"] == 0
    assert status["reflection_skip_count"] == 1
    assert status["last_skip_reason"] == "no_new_information"
    assert provider.chat_calls == 1


@pytest.mark.asyncio
async def test_reflection_loop_skips_when_source_has_not_changed(tmp_path: Path) -> None:
    session_key = "main:telegram:123__s_2026-03-10_22-00-00"
    _write_session(tmp_path / "sessions", session_key)

    provider = _FakeProvider()
    artifacts = CognitiveArtifactStore(tmp_path)
    shared = SharedMindState(tmp_path, cognitive_artifacts=artifacts)
    loop = ReflectionLoop(
        workspace_dir=tmp_path,
        sessions_dir=tmp_path / "sessions",
        provider_getter=lambda: provider,
        shared_mind_state=shared,
        event_bus=None,
        artifact_store=artifacts,
        interval_seconds=300,
    )

    first = await loop.run_once(
        reason="manual",
        event_scope={"chat_id": 123, "session_key": session_key},
        now=datetime(2026, 3, 10, 22, 0, tzinfo=UTC),
    )
    second = await loop.run_once(
        reason="tick",
        event_scope={"chat_id": 123, "session_key": session_key},
        now=datetime(2026, 3, 10, 22, 6, tzinfo=UTC),
    )

    status = loop.status()
    assert first["reflections_written"] == 1
    assert second["reflections_written"] == 0
    assert second["why"] == "no_new_signal"
    assert provider.chat_calls == 1
    assert status["reflection_write_count"] == 1
    assert status["reflection_skip_count"] == 1
    assert status["consecutive_skip_count"] == 1
