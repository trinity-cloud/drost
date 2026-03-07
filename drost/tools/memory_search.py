from __future__ import annotations

from drost.embeddings import EmbeddingService
from drost.storage import SQLiteStore, WorkspaceMemoryIndexer
from drost.tools.base import BaseTool


class MemorySearchTool(BaseTool):
    def __init__(
        self,
        *,
        store: SQLiteStore,
        embeddings: EmbeddingService,
        workspace_memory_indexer: WorkspaceMemoryIndexer,
        default_limit: int = 6,
    ) -> None:
        self._store = store
        self._embeddings = embeddings
        self._workspace_memory_indexer = workspace_memory_indexer
        self._default_limit = max(1, int(default_limit))

    @property
    def name(self) -> str:
        return "memory_search"

    @property
    def description(self) -> str:
        return "Search long-term memory snippets using semantic and keyword retrieval."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query text."},
                "limit": {"type": "integer", "description": "Maximum number of results.", "minimum": 1},
            },
            "required": ["query"],
        }

    async def execute(self, *, query: str, limit: int | None = None) -> str:
        query_text = str(query or "").strip()
        if not query_text:
            return "Error: query is required"

        k = self._default_limit if limit is None else max(1, min(int(limit), 20))
        await self._workspace_memory_indexer.sync()
        query_embedding = await self._embeddings.embed_query(query_text)
        rows = self._store.search_memory(
            query_text=query_text,
            query_embedding=query_embedding,
            limit=k,
        )
        if not rows:
            return "No memory matches found."

        lines: list[str] = [f"Memory search results for: {query_text}"]
        for idx, row in enumerate(rows, start=1):
            source_kind = str(row.get("source_kind") or "")
            path = str(row.get("path") or "")
            line_start = int(row.get("line_start") or 1)
            line_end = int(row.get("line_end") or line_start)
            lines.append(
                f"{idx}. id={int(row.get('id') or 0)} "
                f"source={source_kind or str(row.get('role') or '')} "
                f"session={str(row.get('session_key') or '')} "
                f"score={float(row.get('fused_score') or row.get('score') or 0.0):.4f}"
            )
            if path:
                lines.append(f"   path={path}:{line_start}-{line_end}")
            snippet = str(row.get("snippet") or row.get("content") or "").strip()
            if snippet:
                lines.append(f"   {snippet}")
        return "\n".join(lines)
