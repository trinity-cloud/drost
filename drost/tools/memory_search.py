from __future__ import annotations

from drost.embeddings import EmbeddingService
from drost.storage import SQLiteStore
from drost.tools.base import BaseTool


class MemorySearchTool(BaseTool):
    def __init__(self, *, store: SQLiteStore, embeddings: EmbeddingService, default_limit: int = 6) -> None:
        self._store = store
        self._embeddings = embeddings
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
        query_embedding = await self._embeddings.embed_one(query_text)
        rows = self._store.search_memory(
            query_text=query_text,
            query_embedding=query_embedding,
            limit=k,
        )
        if not rows:
            return "No memory matches found."

        lines: list[str] = [f"Memory search results for: {query_text}"]
        for idx, row in enumerate(rows, start=1):
            lines.append(
                f"{idx}. id={int(row.get('id') or 0)} "
                f"role={str(row.get('role') or '')} "
                f"session={str(row.get('session_key') or '')} "
                f"score={float(row.get('fused_score') or row.get('score') or 0.0):.4f}"
            )
            snippet = str(row.get("snippet") or row.get("content") or "").strip()
            if snippet:
                lines.append(f"   {snippet}")
        return "\n".join(lines)

