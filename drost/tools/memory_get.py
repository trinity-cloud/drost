from __future__ import annotations

from drost.storage import SQLiteStore
from drost.tools.base import BaseTool


class MemoryGetTool(BaseTool):
    def __init__(self, *, store: SQLiteStore) -> None:
        self._store = store

    @property
    def name(self) -> str:
        return "memory_get"

    @property
    def description(self) -> str:
        return "Fetch a full memory chunk by id."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "chunk_id": {"type": "integer", "description": "Memory chunk id."},
            },
            "required": ["chunk_id"],
        }

    async def execute(self, *, chunk_id: int) -> str:
        cid = int(chunk_id)
        row = self._store.get_memory_chunk(cid)
        if row is None:
            return f"Error: memory chunk {cid} not found"
        return (
            f"id={int(row.get('id') or 0)}\n"
            f"session={str(row.get('session_key') or '')}\n"
            f"role={str(row.get('role') or '')}\n"
            f"created_at={str(row.get('created_at') or '')}\n\n"
            f"{str(row.get('content') or '')}"
        )

