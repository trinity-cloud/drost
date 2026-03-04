from __future__ import annotations

from pathlib import Path

from drost.tools.base import BaseTool


class FileReadTool(BaseTool):
    def __init__(self, *, default_limit: int = 8_000, max_limit: int = 64_000) -> None:
        self._default_limit = max(1, int(default_limit))
        self._max_limit = max(self._default_limit, int(max_limit))

    @property
    def name(self) -> str:
        return "file_read"

    @property
    def description(self) -> str:
        return "Read text content from a file path."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute or relative filesystem path."},
                "offset": {"type": "integer", "description": "Character offset to start reading from."},
                "limit": {"type": "integer", "description": "Max characters to return."},
            },
            "required": ["path"],
        }

    async def execute(self, *, path: str, offset: int | None = None, limit: int | None = None) -> str:
        file_path = Path(path).expanduser()
        if not file_path.exists():
            return f"Error: file not found: {file_path}"
        if not file_path.is_file():
            return f"Error: not a file: {file_path}"

        start = 0 if offset is None else max(0, int(offset))
        span = self._default_limit if limit is None else max(1, min(int(limit), self._max_limit))
        content = file_path.read_text(encoding="utf-8", errors="replace")
        end = min(len(content), start + span)
        excerpt = content[start:end]

        lines = [f"path={file_path}", f"offset={start}", f"limit={span}", ""]
        lines.append(excerpt)
        if end < len(content):
            lines.append("")
            lines.append(f"[truncated: returned {end - start} chars, {len(content) - end} chars remaining]")
        return "\n".join(lines)

