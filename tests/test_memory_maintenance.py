from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pytest

from drost.loop_events import LoopEventBus
from drost.memory_files import MemoryFiles
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
    def __init__(self, *, content: str | list[str]) -> None:
        if isinstance(content, list):
            self._responses = list(content)
        else:
            self._responses = [content]
        self.last_messages: list[Message] = []
        self.message_calls: list[list[Message]] = []
        self.system_prompts: list[str] = []

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
        _ = tools, max_tokens, temperature, stop_sequences
        self.last_messages = list(messages)
        self.message_calls.append(list(messages))
        self.system_prompts.append(str(system or ""))
        content = self._responses.pop(0) if self._responses else ""
        return ChatResponse(
            message=Message(role=MessageRole.ASSISTANT, content=content),
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


async def _wait_until(predicate: Callable[[], bool], *, timeout: float = 1.5) -> None:
    import asyncio

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    assert predicate()


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
        content=[
            json.dumps(
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
                    "promotion_candidates": [
                        {
                            "target_file": "MEMORY.md",
                            "candidate_text": "Drost uses Markdown files as durable canonical memory.",
                            "kind": "operational_context",
                            "confidence": 0.98,
                            "stability": 0.95,
                            "evidence_refs": ["sessions/test.jsonl:1", "sessions/test.jsonl:2"],
                            "why_promotable": "This affects future retrieval and prompt quality.",
                        }
                    ],
                }
            ),
            "# Drost\n\nDrost stores durable memory in Markdown files and reindexes them into SQLite.",
        ]
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
    summary_path = workspace / "memory" / "entities" / "projects" / "drost" / "summary.md"
    promoted_memory_path = workspace / "MEMORY.md"
    promotion_journal_path = workspace / "state" / "promotion-decisions.jsonl"
    state_path = workspace / "state" / "memory-maintenance.json"

    assert result["daily_notes_written"] == 1
    assert result["facts_written"] == 1
    assert result["promotions_written"] == 1
    assert result["summaries_written"] == 1
    assert sync_calls == ["sync"]
    assert daily_path.exists()
    assert fact_path.exists()
    assert summary_path.exists()
    assert promoted_memory_path.exists()
    assert promotion_journal_path.exists()
    assert "Markdown files as durable memory" in fact_path.read_text(encoding="utf-8")
    assert "Drost stores durable memory in Markdown files" in summary_path.read_text(encoding="utf-8")
    assert "Drost uses Markdown files as durable canonical memory." in promoted_memory_path.read_text(encoding="utf-8")
    assert json.loads(state_path.read_text(encoding="utf-8"))["files"]
    payload = json.loads(str(provider.message_calls[0][0].content or ""))
    assert payload["events"]
    assert any(event["event_type"] == "tool_trace" for event in payload["events"])
    assert "entity memory synthesis" in provider.system_prompts[1].lower()
    store.close()


@pytest.mark.asyncio
async def test_memory_maintenance_requires_stronger_evidence_for_user_promotions(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)
    session_key = session_key_for_telegram_chat(123, "s_2026-03-07_10-05-00")
    session_store.append_user_assistant(
        session_key=session_key,
        user_text="I like direct answers.",
        assistant_text="I will answer directly.",
    )

    provider = ExtractionProvider(
        content=json.dumps(
            {
                "daily_notes": [],
                "facts": [],
                "promotion_candidates": [
                    {
                        "target_file": "USER.md",
                        "candidate_text": "Prefers direct technical answers.",
                        "kind": "communication_style",
                        "confidence": 0.99,
                        "stability": 0.95,
                        "evidence_refs": ["sessions/test.jsonl:1"],
                        "why_promotable": "Repeated preference.",
                    },
                    {
                        "target_file": "IDENTITY.md",
                        "candidate_text": "Drost is relentlessly formal and severe.",
                        "kind": "identity_trait",
                        "confidence": 0.99,
                        "stability": 0.99,
                        "evidence_refs": ["sessions/test.jsonl:1", "sessions/test.jsonl:2", "sessions/test.jsonl:3"],
                        "why_promotable": "Should remain manual only.",
                    },
                ],
            }
        )
    )

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
    journal_path = workspace / "state" / "promotion-decisions.jsonl"
    journal_rows = [json.loads(line) for line in journal_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    assert result["promotions_written"] == 0
    assert not (workspace / "USER.md").exists()
    assert not (workspace / "IDENTITY.md").exists()
    assert [row["reason"] for row in journal_rows] == ["insufficient_evidence_refs", "manual_review_required"]


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


@pytest.mark.asyncio
async def test_memory_maintenance_resolves_aliases_and_writes_relations(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)
    memory = MemoryFiles(workspace)
    memory.append_entity_alias(entity_type="projects", entity_id="drost", alias="the repo")

    session_key = session_key_for_telegram_chat(123, "s_2026-03-08_08-00-00")
    session_store.append_user_assistant(
        session_key=session_key,
        user_text="Remember that the repo should use the deployer by default.",
        assistant_text="Understood. I will store that for Drost.",
    )

    provider = ExtractionProvider(
        content=[
            json.dumps(
                {
                    "daily_notes": [],
                    "entities": [
                        {"entity_type": "projects", "entity_name": "Drost"},
                        {"entity_type": "people", "entity_name": "Migel"},
                    ],
                    "aliases": [
                        {
                            "entity_type": "projects",
                            "entity_name": "Drost",
                            "alias": "/Users/migel/drost",
                        }
                    ],
                    "facts": [
                        {
                            "entity_type": "projects",
                            "entity_name": "the repo",
                            "kind": "decision",
                            "fact": "Drost should use the deployer as the default startup path.",
                            "date": "2026-03-08",
                            "confidence": 0.95,
                        }
                    ],
                    "relations": [
                        {
                            "from_entity_type": "projects",
                            "from_entity_name": "the repo",
                            "relation_type": "owned_by",
                            "to_entity_type": "people",
                            "to_entity_name": "Migel",
                            "statement": "Drost is owned and directed by Migel.",
                            "date": "2026-03-08",
                            "confidence": 0.99,
                        }
                    ],
                }
            ),
            "# Drost\n\nDrost should use the deployer as the default startup path.",
        ]
    )

    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)
    sync_calls: list[str] = []

    async def _sync_index() -> dict[str, int]:
        sync_calls.append("sync")
        return {"indexed": 3, "skipped": 0, "removed": 0}

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

    alias_path = workspace / "memory" / "entities" / "projects" / "drost" / "aliases.md"
    fact_path = workspace / "memory" / "entities" / "projects" / "drost" / "items.md"
    relation_path = workspace / "memory" / "entities" / "projects" / "drost" / "relations.md"

    assert result["aliases_written"] == 1
    assert result["facts_written"] == 1
    assert result["relations_written"] == 1
    assert sync_calls == ["sync"]
    assert alias_path.exists()
    assert fact_path.exists()
    assert relation_path.exists()
    assert "/Users/migel/drost" in alias_path.read_text(encoding="utf-8")
    assert "default startup path" in fact_path.read_text(encoding="utf-8")
    relation_text = relation_path.read_text(encoding="utf-8")
    assert "[to:people/migel]" in relation_text
    assert "Drost is owned and directed by Migel." in relation_text
    synthesis_payload = json.loads(str(provider.message_calls[1][0].content or ""))
    assert "relations_md" in synthesis_payload
    assert "owned and directed by Migel" in synthesis_payload["relations_md"]
    store.close()


@pytest.mark.asyncio
async def test_memory_maintenance_extracts_followups_with_session_provenance(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)

    session_key = session_key_for_telegram_chat(8271705169, "s_2026-03-09_10-00-00")
    session_store.append_user_assistant(
        session_key=session_key,
        user_text="I have a CPAP fitting appointment tomorrow at 11am. Check in with me after.",
        assistant_text="Noted. I will remember to check in after the appointment.",
    )

    provider = ExtractionProvider(
        content=json.dumps(
            {
                "daily_notes": [],
                "entities": [{"entity_type": "people", "entity_name": "Migel"}],
                "aliases": [],
                "facts": [],
                "relations": [],
                "follow_ups": [
                    {
                        "kind": "check_in",
                        "subject": "CPAP fitting appointment",
                        "entity_refs": ["people/Migel"],
                        "source": f"{session_key}.jsonl:1",
                        "source_session_key": session_key,
                        "source_excerpt": "CPAP fitting appointment tomorrow at 11am",
                        "follow_up_prompt": "How did the CPAP fitting go?",
                        "due_at": "2026-03-10T19:00:00Z",
                        "not_before": "2026-03-10T17:00:00Z",
                        "priority": "high",
                        "confidence": 0.96,
                    }
                ],
            }
        )
    )

    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)

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

    followups_path = workspace / "memory" / "follow-ups.json"
    payload = json.loads(followups_path.read_text(encoding="utf-8"))
    assert result["followups_written"] == 1
    assert payload["items"][0]["chat_id"] == 8271705169
    assert payload["items"][0]["source_session_key"] == session_key
    assert payload["items"][0]["entity_refs"] == ["people/migel"]

    store.close()


@pytest.mark.asyncio
async def test_memory_maintenance_wakes_on_assistant_turn_completed_event(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    session_store = SessionJSONLStore(store_path=sessions)
    session_key = session_key_for_telegram_chat(456, "s_2026-03-10_10-00-00")
    bus = LoopEventBus()

    provider = ExtractionProvider(
        content=json.dumps(
            {
                "daily_notes": [
                    {
                        "date": "2026-03-10",
                        "bullets": ["Recorded an event-driven maintenance wake-up."],
                    }
                ],
                "facts": [],
            }
        )
    )

    async def _sync_index() -> dict[str, int]:
        return {"indexed": 1, "skipped": 0, "removed": 0}

    runner = MemoryMaintenanceRunner(
        workspace_dir=workspace,
        sessions_dir=sessions,
        provider_getter=lambda: provider,
        sync_memory_index=_sync_index,
        enabled=True,
        event_bus=bus,
        interval_seconds=3600,
        max_events_per_run=200,
    )

    await runner.start()
    try:
        session_store.append_user_assistant(
            session_key=session_key,
            user_text="Remember that maintenance should wake from the event bus.",
            assistant_text="Understood. I will wake maintenance from assistant completion events.",
        )
        bus.emit(
            "assistant_turn_completed",
            scope={"chat_id": 456, "session_key": session_key},
            payload={"provider": "fake-extraction"},
        )

        daily_path = workspace / "memory" / "daily" / "2026-03-10.md"
        await _wait_until(lambda: daily_path.exists())
        assert "event-driven maintenance wake-up" in daily_path.read_text(encoding="utf-8")
    finally:
        await runner.stop()

    status = bus.status()
    assert status["event_counts"]["assistant_turn_completed"] == 1
    assert status["event_counts"]["memory_maintenance_completed"] == 1
