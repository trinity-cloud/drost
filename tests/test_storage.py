from __future__ import annotations

import asyncio
from pathlib import Path

from drost.embeddings import EmbeddingService
from drost.config import Settings
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
