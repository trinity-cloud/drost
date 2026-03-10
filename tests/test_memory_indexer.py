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
    (entity_dir / "aliases.md").write_text(
        "# Aliases\n\n- Drost\n- /Users/migel/drost\n",
        encoding="utf-8",
    )
    (entity_dir / "relations.md").write_text(
        "# Relationships (append-only)\n\n"
        "- [id:projects/drost/relations/0001] [ts:2026-03-09] [rel:owned_by] [to:people/migel] [conf:0.99]\n"
        "  Drost is owned and directed by Migel.\n\n",
        encoding="utf-8",
    )
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
    assert result["indexed"] == 5
    assert result["graph_entities"] == 1
    assert result["graph_aliases"] == 2
    assert result["graph_relations"] == 1
    indexed = store.list_indexed_files()
    assert {row["path"] for row in indexed} == {
        "MEMORY.md",
        "memory/daily/2026-03-06.md",
        "memory/entities/projects/drost/aliases.md",
        "memory/entities/projects/drost/relations.md",
        "memory/entities/projects/drost/summary.md",
    }

    query = "canonical Markdown memory"
    query_embedding = asyncio.run(embeddings.embed_query(query))
    rows = store.search_memory(query_text=query, query_embedding=query_embedding, limit=5)
    assert any(str(row.get("path") or "") == "MEMORY.md" for row in rows)
    assert any(str(row.get("source_kind") or "") == "workspace_memory" for row in rows)

    alias_hit = store.find_entity_by_alias("/Users/migel/drost")
    assert alias_hit is not None
    assert alias_hit["entity_type"] == "projects"
    assert alias_hit["entity_id"] == "drost"

    entities = store.list_memory_entities()
    assert entities == [
        {
            "entity_type": "projects",
            "entity_id": "drost",
            "title": "projects/drost",
            "entity_path": "memory/entities/projects/drost",
            "summary_path": "memory/entities/projects/drost/summary.md",
            "updated_at": entities[0]["updated_at"],
        }
    ]

    relations = store.list_entity_relations("projects", "drost")
    assert len(relations) == 1
    assert relations[0]["relation_type"] == "owned_by"
    assert relations[0]["to_entity_type"] == "people"
    assert relations[0]["to_entity_id"] == "migel"

    relation_query = "Who owns Drost?"
    relation_embedding = asyncio.run(embeddings.embed_query(relation_query))
    relation_rows = store.search_memory(query_text=relation_query, query_embedding=relation_embedding, limit=5)
    assert any(str(row.get("source_kind") or "") == "entity_relation" for row in relation_rows)

    asyncio.run(embeddings.close())
    store.close()
