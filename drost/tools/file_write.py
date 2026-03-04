from __future__ import annotations

from pathlib import Path

from drost.tools.base import BaseTool


class FileWriteTool(BaseTool):
    @property
    def name(self) -> str:
        return "file_write"

    @property
    def description(self) -> str:
        return "Write full text content to a file path, creating directories as needed."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute or relative filesystem path."},
                "content": {"type": "string", "description": "Full file content to write."},
            },
            "required": ["path", "content"],
        }

    async def execute(self, *, path: str, content: str) -> str:
        file_path = Path(path).expanduser()
        file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = str(content or "")
        file_path.write_text(payload, encoding="utf-8")
        return f"Wrote {len(payload)} chars to {file_path}"

