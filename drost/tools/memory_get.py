from __future__ import annotations

from pathlib import Path

from drost.storage import SQLiteStore
from drost.tools.base import BaseTool


class MemoryGetTool(BaseTool):
    def __init__(self, *, store: SQLiteStore, workspace_dir: Path) -> None:
        self._store = store
        self._workspace_dir = Path(workspace_dir).expanduser()

    @property
    def name(self) -> str:
        return "memory_get"

    @property
    def description(self) -> str:
        return "Fetch a memory chunk by id or read a memory file excerpt by path."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "chunk_id": {"type": "integer", "description": "Memory chunk id."},
                "path": {"type": "string", "description": "Workspace-relative or absolute file path."},
                "line_start": {"type": "integer", "description": "1-based starting line number.", "minimum": 1},
                "line_end": {"type": "integer", "description": "1-based ending line number.", "minimum": 1},
            },
            "required": [],
        }

    async def execute(
        self,
        *,
        chunk_id: int | None = None,
        path: str | None = None,
        line_start: int | None = None,
        line_end: int | None = None,
    ) -> str:
        if path:
            target = Path(str(path).strip())
            resolved = target if target.is_absolute() else (self._workspace_dir / target).resolve()
            if not resolved.exists() or not resolved.is_file():
                return f"Error: memory file not found: {path}"
            try:
                lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception as exc:
                return f"Error: failed to read memory file: {exc}"
            start = max(1, int(line_start or 1))
            end = max(start, int(line_end or len(lines) or start))
            excerpt = "\n".join(lines[start - 1 : end]).strip()
            if not excerpt:
                return f"Error: no content found in {path}:{start}-{end}"
            return f"path={resolved}\nlines={start}-{end}\n\n{excerpt}"

        if chunk_id is None:
            return "Error: chunk_id or path is required"

        cid = int(chunk_id)
        row = self._store.get_memory_chunk(cid)
        if row is None:
            return f"Error: memory chunk {cid} not found"
        path_text = str(row.get("path") or "")
        path_line = ""
        if path_text:
            path_line = (
                f"path={path_text}:{int(row.get('line_start') or 1)}-{int(row.get('line_end') or row.get('line_start') or 1)}\n"
            )
        return (
            f"id={int(row.get('id') or 0)}\n"
            f"source_kind={str(row.get('source_kind') or '')}\n"
            f"session={str(row.get('session_key') or '')}\n"
            f"role={str(row.get('role') or '')}\n"
            f"{path_line}"
            f"created_at={str(row.get('created_at') or '')}\n\n"
            f"{str(row.get('content') or '')}"
        )
