from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.memory_capsule import MemoryCapsuleBuilder


def test_memory_capsule_prefers_high_order_memory_sources(tmp_path: Path) -> None:
    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_memory_tokens=8_000,
        memory_capsule_enabled=True,
        memory_capsule_search_limit=18,
    )
    builder = MemoryCapsuleBuilder(settings)

    candidates = [
        {
            "id": 11,
            "source_kind": "transcript_message",
            "session_key": "main:telegram:1__s_1",
            "title": "",
            "path": "",
            "snippet": "You previously said to maybe think about repositioning some tech exposure.",
            "line_start": 1,
            "line_end": 1,
            "fused_score": 0.012,
        },
        {
            "id": 12,
            "source_kind": "entity_summary",
            "title": "projects/drost",
            "path": "memory/entities/projects/drost/summary.md",
            "snippet": "Drost compounds memory into Markdown and reindexes it into SQLite with Gemini embeddings.",
            "line_start": 1,
            "line_end": 6,
            "fused_score": 0.010,
        },
        {
            "id": 13,
            "source_kind": "daily_memory",
            "title": "daily/2026-03-08",
            "path": "memory/daily/2026-03-08.md",
            "snippet": "Confirmed that session continuity and prompt-time memory capsule are the next build steps.",
            "line_start": 1,
            "line_end": 3,
            "fused_score": 0.009,
        },
        {
            "id": 14,
            "source_kind": "workspace_memory",
            "title": "MEMORY.md",
            "path": "MEMORY.md",
            "snippet": "Drost should keep durable memory in Markdown files and use SQLite as the derived index.",
            "line_start": 1,
            "line_end": 4,
            "fused_score": 0.008,
        },
    ]

    capsule = builder.build(
        query_text="What have we decided about Drost memory continuity and prompt injection?",
        candidates=candidates,
        continuity_summary="## Session Continuity\n### Open Threads\n- Build prompt-time memory capsule.",
    )

    assert "[Memory Capsule]" in capsule
    assert "[Session Continuity]" in capsule
    assert "Build prompt-time memory capsule" in capsule
    assert "[Relevant MEMORY.md]" in capsule
    assert "[Relevant Daily Memory]" in capsule
    assert "[Relevant Entity Summaries]" in capsule
    assert "[Relevant Transcript Recall]" not in capsule


def test_memory_capsule_falls_back_to_transcript_when_high_order_memory_is_weak(tmp_path: Path) -> None:
    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_memory_tokens=8_000,
        memory_capsule_enabled=True,
        memory_capsule_search_limit=18,
    )
    builder = MemoryCapsuleBuilder(settings)

    candidates = [
        {
            "id": 21,
            "source_kind": "transcript_message",
            "session_key": "main:telegram:1__s_2",
            "title": "",
            "path": "",
            "snippet": "You said to reposition the portfolio by cutting tech exposure and adding energy, gold, and cash.",
            "line_start": 1,
            "line_end": 1,
            "fused_score": 0.009,
        },
        {
            "id": 22,
            "source_kind": "entity_summary",
            "title": "projects/drost",
            "path": "memory/entities/projects/drost/summary.md",
            "snippet": "Drost is an open-source agent runtime.",
            "line_start": 1,
            "line_end": 2,
            "fused_score": 0.001,
        },
    ]

    capsule = builder.build(
        query_text="How did we want to reposition the portfolio?",
        candidates=candidates,
        continuity_summary="",
    )

    assert "[Relevant Transcript Recall]" in capsule
    assert "cutting tech exposure" in capsule


def test_memory_capsule_includes_relationships_for_relation_queries(tmp_path: Path) -> None:
    settings = Settings(
        workspace_dir=tmp_path,
        context_budget_memory_tokens=8_000,
        memory_capsule_enabled=True,
        memory_capsule_search_limit=18,
    )
    builder = MemoryCapsuleBuilder(settings)

    candidates = [
        {
            "id": 31,
            "source_kind": "entity_summary",
            "title": "projects/drost",
            "path": "memory/entities/projects/drost/summary.md",
            "snippet": "Drost is an AI agent runtime with durable memory and a deployer control plane.",
            "line_start": 1,
            "line_end": 4,
            "fused_score": 0.020,
        },
        {
            "id": 0,
            "source_kind": "entity_relation",
            "title": "projects/drost",
            "path": "memory/entities/projects/drost/relations.md",
            "snippet": "Drost is owned and directed by Migel.",
            "content": "Drost is owned and directed by Migel.",
            "line_start": 3,
            "line_end": 4,
            "derived_from": "projects/drost/relations/0001",
            "fused_score": 0.028,
        },
        {
            "id": 32,
            "source_kind": "entity_summary",
            "title": "people/migel",
            "path": "memory/entities/people/migel/summary.md",
            "snippet": "Migel owns and directs the Drost project.",
            "line_start": 1,
            "line_end": 3,
            "fused_score": 0.019,
        },
    ]

    capsule = builder.build(
        query_text="Who owns Drost and how are they connected?",
        candidates=candidates,
        continuity_summary="",
    )

    assert "[Relevant Relationships]" in capsule
    assert "owned and directed by Migel" in capsule
    assert "[Relevant Entity Summaries]" in capsule
