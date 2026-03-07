from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from drost.memory_maintenance import MemoryMaintenanceRunner
from drost.providers import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
    ToolResult,
)
from drost.storage import SessionJSONLStore, SQLiteStore, session_key_for_telegram_chat


class ExtractionProvider(BaseProvider):
    def __init__(self, *, content: str) -> None:
        self._content = content
        self.last_messages: list[Message] = []

    @property
    def name(self) -> str:
        return "fake-extraction"

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
        _ = system, tools, max_tokens, temperature, stop_sequences
        self.last_messages = list(messages)
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=self._content),
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
    ) -> AsyncIterator[StreamDelta]:
        _ = messages, system, tools, max_tokens, temperature, stop_sequences
        if False:
            yield StreamDelta(content="")


@pytest.mark.asyncio
async def test_memory_maintenance_run_once_writes_memory_and_advances_state(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)
    session_key = session_key_for_telegram_chat(123, "s_2026-03-07_10-00-00")
    session_store.append_user_assistant(
        session_key=session_key,
        user_text="Remember that Drost should compound memory into Markdown.",
        assistant_text="Understood. We will use Markdown files as durable memory.",
    )
    session_store.append_full_messages(
        session_key=session_key,
        messages=[
            Message(
                role=MessageRole.ASSISTANT,
                content="Searching docs",
                tool_calls=[ToolCall(id="call-1", name="web_search", arguments={"query": "drost memory"})],
            ),
            Message(
                role=MessageRole.TOOL,
                tool_results=[ToolResult(tool_call_id="call-1", content="Found design notes", is_error=False)],
            ),
        ],
    )

    provider = ExtractionProvider(
        content=json.dumps(
            {
                "daily_notes": [
                    {
                        "date": "2026-03-07",
                        "bullets": ["Confirmed Drost memory should compound into Markdown files."],
                    }
                ],
                "facts": [
                    {
                        "entity_type": "projects",
                        "entity_id": "drost",
                        "kind": "decision",
                        "fact": "Drost should use Markdown files as durable memory.",
                        "date": "2026-03-07",
                        "confidence": 0.96,
                        "source": "sessions/test.jsonl:1",
                    }
                ],
            }
        )
    )

    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)
    sync_calls: list[str] = []

    async def _sync_index() -> dict[str, int]:
        sync_calls.append("sync")
        return {"indexed": 2, "skipped": 0, "removed": 0}

    runner = MemoryMaintenanceRunner(
        workspace_dir=workspace,
        sessions_dir=sessions,
        provider_getter=lambda: provider,
        sync_memory_index=_sync_index,
        enabled=True,
        interval_seconds=1800,
        max_events_per_run=200,
    )

    result = await runner.run_once(reason="test")

    daily_path = workspace / "memory" / "daily" / "2026-03-07.md"
    fact_path = workspace / "memory" / "entities" / "projects" / "drost" / "items.md"
    state_path = workspace / "state" / "memory-maintenance.json"

    assert result["daily_notes_written"] == 1
    assert result["facts_written"] == 1
    assert sync_calls == ["sync"]
    assert daily_path.exists()
    assert fact_path.exists()
    assert "Markdown files as durable memory" in fact_path.read_text(encoding="utf-8")
    assert json.loads(state_path.read_text(encoding="utf-8"))["files"]
    payload = json.loads(str(provider.last_messages[0].content or ""))
    assert payload["events"]
    assert any(event["event_type"] == "tool_trace" for event in payload["events"])
    store.close()


@pytest.mark.asyncio
async def test_memory_maintenance_parse_failure_does_not_advance_state(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)
    session_key = session_key_for_telegram_chat(123, "s_2026-03-07_10-10-00")
    session_store.append_user_assistant(
        session_key=session_key,
        user_text="Remember that I prefer direct answers.",
        assistant_text="I will keep answers direct.",
    )

    provider = ExtractionProvider(content="not json")

    async def _sync_index() -> dict[str, int]:
        return {"indexed": 0, "skipped": 0, "removed": 0}

    runner = MemoryMaintenanceRunner(
        workspace_dir=workspace,
        sessions_dir=sessions,
        provider_getter=lambda: provider,
        sync_memory_index=_sync_index,
        enabled=True,
        interval_seconds=1800,
        max_events_per_run=200,
    )

    result = await runner.run_once(reason="test")
    state_path = workspace / "state" / "memory-maintenance.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))

    assert "error" in result
    assert state["files"] == {}
