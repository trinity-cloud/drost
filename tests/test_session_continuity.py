from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from drost.providers import (
    BaseProvider,
    ChatResponse,
    Message,
    MessageRole,
    StreamDelta,
    ToolCall,
    ToolResult,
)
from drost.session_continuity import ContinuityJobRequest, SessionContinuityManager
from drost.storage import SessionJSONLStore, SQLiteStore, session_key_for_telegram_chat


class ContinuityProvider(BaseProvider):
    def __init__(self, content: str) -> None:
        self._content = content
        self.calls: list[dict[str, object]] = []

    @property
    def name(self) -> str:
        return "fake-continuity"

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
        self.calls.append(
            {
                "messages": list(messages),
                "system": str(system or ""),
            }
        )
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
async def test_session_continuity_manager_generates_and_persists_summary(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)

    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)
    session_store = SessionJSONLStore(store_path=sessions)

    from_key = session_key_for_telegram_chat(123, "s_2026-03-07_09-00-00")
    to_key = session_key_for_telegram_chat(123, "s_2026-03-07_09-30-00")
    store.append_message(from_key, "user", "We need to improve Drost memory continuity.")
    store.append_message(from_key, "assistant", "Next I will build the continuity manager and prompt injection.")
    session_store.append_full_messages(
        session_key=from_key,
        messages=[
            Message(
                role=MessageRole.ASSISTANT,
                content="Checking the plan",
                tool_calls=[ToolCall(id="call-1", name="file_read", arguments={"path": "AGENTS.md"})],
            ),
            Message(role=MessageRole.TOOL, tool_results=[ToolResult(tool_call_id="call-1", content="Loaded file")]),
        ],
    )
    session_store.append_full_messages(
        session_key=from_key,
        messages=[
            Message(
                role=MessageRole.ASSISTANT,
                content="Researching continuity design",
                tool_calls=[],
            )
        ],
    )

    provider = ContinuityProvider(
        "## Session Continuity\n### Core Objective\nImprove memory continuity.\n### Decisions And Constraints\n- Keep it internal.\n### Work Completed\n- Planned the manager.\n### Open Threads\n- Implement prompt injection.\n### Suggested Next Actions\n- Build the continuity manager."
    )
    manager = SessionContinuityManager(
        store=store,
        sessions_dir=sessions,
        provider_getter=lambda: provider,
        embed_document=_embed_constant,
        enabled=True,
        source_max_messages=50,
        source_max_chars=12_000,
        summary_max_tokens=800,
        summary_max_chars=4_000,
    )

    result = await manager.schedule(
        ContinuityJobRequest(
            chat_id=123,
            from_session_id="s_2026-03-07_09-00-00",
            from_session_key=from_key,
            to_session_id="s_2026-03-07_09-30-00",
            to_session_key=to_key,
        )
    )
    await manager.wait_for_idle()

    assert result["queued"] is True
    continuity = store.get_session_continuity(to_key)
    assert continuity is not None
    assert "Improve memory continuity" in continuity["summary"]
    rows = store.search_memory(
        query_text="memory continuity prompt injection",
        query_embedding=[0.25] * 64,
        limit=5,
    )
    assert rows
    assert rows[0]["source_kind"] == "session_continuity"
    assert provider.calls
    assert "continuity handoff" in str(provider.calls[0]["system"]).lower()
    prompt = str(provider.calls[0]["messages"][0].content or "")
    assert "[Narrative Transcript]" in prompt
    assert "improve drost memory continuity" in prompt.lower()
    assert "[Tool Artifacts]" in prompt
    assert "file_read" in prompt
    status = manager.status()
    assert status["completed_jobs"] == 1
    assert status["failed_jobs"] == 0
    store.close()


@pytest.mark.asyncio
async def test_session_continuity_schedule_skips_when_no_prior_messages(tmp_path: Path) -> None:
    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)
    provider = ContinuityProvider("unused")
    manager = SessionContinuityManager(
        store=store,
        sessions_dir=tmp_path / "sessions",
        provider_getter=lambda: provider,
        enabled=True,
    )

    result = await manager.schedule(
        ContinuityJobRequest(
            chat_id=123,
            from_session_id="s_2026-03-07_09-00-00",
            from_session_key=session_key_for_telegram_chat(123, "s_2026-03-07_09-00-00"),
            to_session_id="s_2026-03-07_09-30-00",
            to_session_key=session_key_for_telegram_chat(123, "s_2026-03-07_09-30-00"),
        )
    )

    assert result["queued"] is False
    assert "no prior messages" in result["message"].lower()
    store.close()


@pytest.mark.asyncio
async def test_session_continuity_includes_graph_context_when_aliases_match(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)

    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3", vector_dimensions=64)
    session_store = SessionJSONLStore(store_path=sessions)

    from_key = session_key_for_telegram_chat(321, "s_2026-03-08_10-00-00")
    to_key = session_key_for_telegram_chat(321, "s_2026-03-08_11-00-00")
    store.append_message(from_key, "user", "We need to tighten deploy safety for the repo.")
    store.append_message(from_key, "assistant", "Understood. I will keep the deploy path coherent.")
    session_store.append_full_messages(
        session_key=from_key,
        messages=[
            Message(
                role=MessageRole.ASSISTANT,
                content="Checking deploy state",
                tool_calls=[ToolCall(id="call-1", name="deployer_status", arguments={})],
            ),
            Message(role=MessageRole.TOOL, tool_results=[ToolResult(tool_call_id="call-1", content="healthy")]),
        ],
    )

    updated_at = "2026-03-08T10:00:00+00:00"
    store.replace_indexed_file(
        path="memory/entities/projects/drost/summary.md",
        source_kind="entity_summary",
        title="projects/drost",
        file_hash="summary-hash",
        updated_at=updated_at,
        chunks=[
            {
                "title": "projects/drost",
                "content": "Drost deploys through the deployer control plane and is owned by Migel.",
                "line_start": 1,
                "line_end": 2,
                "created_at": updated_at,
                "derived_from": "",
                "embedding": [0.25] * 64,
            }
        ],
    )
    store.replace_graph_index(
        entities=[
            {
                "entity_type": "projects",
                "entity_id": "drost",
                "title": "projects/drost",
                "entity_path": "memory/entities/projects/drost",
                "summary_path": "memory/entities/projects/drost/summary.md",
                "updated_at": updated_at,
            }
        ],
        aliases=[
            {
                "entity_type": "projects",
                "entity_id": "drost",
                "alias": "the repo",
                "path": "memory/entities/projects/drost/aliases.md",
                "updated_at": updated_at,
            }
        ],
        relations=[
            {
                "relation_id": "projects/drost/relations/0001",
                "from_entity_type": "projects",
                "from_entity_id": "drost",
                "relation_type": "owned_by",
                "to_entity_type": "people",
                "to_entity_id": "migel",
                "relation_text": "Drost is owned and directed by Migel.",
                "confidence": 0.99,
                "path": "memory/entities/projects/drost/relations.md",
                "line_start": 1,
                "line_end": 2,
                "updated_at": updated_at,
            }
        ],
    )

    provider = ContinuityProvider(
        "## Session Continuity\n### Core Objective\nKeep deploy safety coherent.\n### Decisions And Constraints\n- Use the deployer.\n### Work Completed\n- Reviewed deploy state.\n### Open Threads\n- Tighten rollback validation.\n### Suggested Next Actions\n- Improve deploy canaries."
    )
    manager = SessionContinuityManager(
        store=store,
        sessions_dir=sessions,
        provider_getter=lambda: provider,
        embed_document=_embed_constant,
        enabled=True,
    )

    result = await manager.schedule(
        ContinuityJobRequest(
            chat_id=321,
            from_session_id="s_2026-03-08_10-00-00",
            from_session_key=from_key,
            to_session_id="s_2026-03-08_11-00-00",
            to_session_key=to_key,
        )
    )
    await manager.wait_for_idle()

    assert result["queued"] is True
    prompt = str(provider.calls[0]["messages"][0].content or "")
    assert "[Graph Context]" in prompt
    assert "Drost deploys through the deployer control plane" in prompt
    assert "owned_by people/migel" in prompt
    store.close()


async def _embed_constant(text: str, *, title: str | None = None) -> list[float]:
    _ = text, title
    return [0.25] * 64
