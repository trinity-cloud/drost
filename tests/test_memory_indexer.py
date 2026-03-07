from __future__ import annotations

import asyncio
from pathlib import Path

from drost.config import Settings
from drost.embeddings import EmbeddingService
from drost.storage import SQLiteStore, WorkspaceMemoryIndexer


def test_workspace_memory_indexer_indexes_workspace_files(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "MEMORY.md").write_text(
        "# Memory\n\nDrost uses Markdown files as canonical memory.",
        encoding="utf-8",
    )
    daily_dir = workspace / "memory" / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    (daily_dir / "2026-03-06.md").write_text(
        "# 2026-03-06\n\n- Reviewed Drost memory architecture.",
        encoding="utf-8",
    )
    entity_dir = workspace / "memory" / "entities" / "projects" / "drost"
    entity_dir.mkdir(parents=True, exist_ok=True)
    (entity_dir / "summary.md").write_text(
        "Drost is an open-source AI agent runtime with layered memory.",
        encoding="utf-8",
    )

    settings = Settings(
        _env_file=None,
        workspace_dir=workspace,
        trace_enabled=False,
        sqlite_path=tmp_path / "drost.sqlite3",
        memory_embedding_provider="none",
        memory_embedding_dimensions=64,
    )
    store = SQLiteStore(db_path=settings.sqlite_path, vector_dimensions=64)
    embeddings = EmbeddingService(settings)
    indexer = WorkspaceMemoryIndexer(workspace_dir=workspace, store=store, embeddings=embeddings)

    result = asyncio.run(indexer.sync())
    assert result["indexed"] == 3
    indexed = store.list_indexed_files()
    assert {row["path"] for row in indexed} == {
        "MEMORY.md",
        "memory/daily/2026-03-06.md",
        "memory/entities/projects/drost/summary.md",
    }

    query = "canonical Markdown memory"
    query_embedding = asyncio.run(embeddings.embed_query(query))
    rows = store.search_memory(query_text=query, query_embedding=query_embedding, limit=5)
    assert any(str(row.get("path") or "") == "MEMORY.md" for row in rows)
    assert any(str(row.get("source_kind") or "") == "workspace_memory" for row in rows)

    asyncio.run(embeddings.close())
    store.close()
