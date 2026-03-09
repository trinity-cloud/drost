from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.storage import SQLiteStore, session_key_for_telegram_chat


def test_session_roundtrip(tmp_path: Path) -> None:
    store = SQLiteStore(db_path=tmp_path / "drost.sqlite3")

    session_key = session_key_for_telegram_chat(12345, None)
    store.append_message(session_key, "user", "hello")
    store.append_message(session_key, "assistant", "world")

    history = store.read_history(session_key, limit=10)
    assert len(history) == 2
    assert history[0]["content"] == "hello"
    assert history[1]["content"] == "world"

    store.close()


def test_session_continuity_roundtrip_and_reset(tmp_path: Path) -> None:
    store = SQLiteStore(db_path=tmp_path / "drost-continuity.sqlite3")
    from_key = session_key_for_telegram_chat(12345, "s_2026-03-07_10-00-00")
    to_key = session_key_for_telegram_chat(12345, "s_2026-03-07_11-00-00")

    store.append_message(from_key, "user", "We agreed to build session continuity.")
    store.set_session_continuity(
        to_session_key=to_key,
        from_session_key=from_key,
        from_session_id="s_2026-03-07_10-00-00",
        summary="## Session Continuity\n### Open Threads\n- Build continuity.",
    )

    row = store.get_session_continuity(to_key)
    assert row is not None
    assert row["from_session_key"] == from_key
    assert "Build continuity" in row["summary"]

    store.reset_session(to_key)
    assert store.get_session_continuity(to_key) is None
    store.close()


def test_memory_search_fallback(tmp_path: Path) -> None:
    store = SQLiteStore(
        db_path=tmp_path / "drost-memory.sqlite3",
        vector_dimensions=64,
    )

    settings = Settings(
        memory_embedding_provider="none",
        memory_embedding_dimensions=64,
        sqlite_path=tmp_path / "drost-memory.sqlite3",
    )
    embed = EmbeddingService(settings)

    session_key = session_key_for_telegram_chat(999, None)
    query = "deployment rollback procedure"
    vector = asyncio.run(embed.embed_one(query))

    store.add_memory(
        session_key=session_key,
        role="assistant",
        content="Use rollback.sh after a failed deployment.",
        embedding=vector,
    )
    rows = store.search_memory(query_text=query, query_embedding=vector, limit=3)
    assert rows
    assert "rollback" in rows[0]["content"].lower()

    asyncio.run(embed.close())
    store.close()


def test_memory_search_handles_hyphenated_queries(tmp_path: Path) -> None:
    store = SQLiteStore(
        db_path=tmp_path / "drost-memory-hyphen.sqlite3",
        vector_dimensions=64,
    )

    settings = Settings(
        memory_embedding_provider="none",
        memory_embedding_dimensions=64,
        sqlite_path=tmp_path / "drost-memory-hyphen.sqlite3",
    )
    embed = EmbeddingService(settings)

    session_key = session_key_for_telegram_chat(1001, None)
    query = "third-party offensive capabilities"
    vector = asyncio.run(embed.embed_one(query))

    store.add_memory(
        session_key=session_key,
        role="assistant",
        content="We should map third-party capabilities before building offensive tooling.",
        embedding=vector,
    )
    rows = store.search_memory(query_text=query, query_embedding=vector, limit=3)
    assert rows
    assert "third-party" in rows[0]["content"].lower()

    asyncio.run(embed.close())
    store.close()


def test_memory_store_reconciles_embedding_dimension_changes(tmp_path: Path) -> None:
    db_path = tmp_path / "drost-memory-migrate.sqlite3"
    session_key = session_key_for_telegram_chat(2002, None)

    initial = SQLiteStore(db_path=db_path, vector_dimensions=64)
    initial.add_memory(
        session_key=session_key,
        role="assistant",
        content="Initial memory vector state.",
        embedding=[0.125] * 64,
    )
    initial.close()

    migrated = SQLiteStore(db_path=db_path, vector_dimensions=128)
    assert migrated.memory_status()["vector_dimensions"] == 128
    migrated.close()

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute("SELECT embedding FROM memory_chunks LIMIT 1").fetchone()
        assert row is not None
        assert row[0] is None
    finally:
        conn.close()
