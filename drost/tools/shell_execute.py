from __future__ import annotations

import asyncio
from pathlib import Path

from drost.tools.base import BaseTool


class ShellExecuteTool(BaseTool):
    def __init__(self, *, default_timeout_seconds: float = 30.0, output_limit: int = 16_000) -> None:
        self._default_timeout = max(1.0, float(default_timeout_seconds))
        self._output_limit = max(512, int(output_limit))

    @property
    def name(self) -> str:
        return "shell_execute"

    @property
    def description(self) -> str:
        return "Run a shell command and return exit code plus stdout/stderr."

    @property
    def parameters(self) -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute."},
                "workdir": {"type": "string", "description": "Optional working directory."},
                "timeout_seconds": {"type": "number", "description": "Execution timeout in seconds."},
            },
            "required": ["command"],
        }

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return text[:limit] + f"\n...[truncated {len(text) - limit} chars]"

    async def execute(
        self,
        *,
        command: str,
        workdir: str | None = None,
        timeout_seconds: float | None = None,
    ) -> str:
        cmd = str(command or "").strip()
        if not cmd:
            return "Error: command is required"

        cwd = None
        if workdir:
            cwd_path = Path(workdir).expanduser()
            if not cwd_path.exists():
                return f"Error: workdir not found: {cwd_path}"
            if not cwd_path.is_dir():
                return f"Error: workdir is not a directory: {cwd_path}"
            cwd = str(cwd_path)

        timeout = self._default_timeout if timeout_seconds is None else max(1.0, float(timeout_seconds))
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_raw, stderr_raw = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return f"Error: command timed out after {timeout:.1f}s"

        stdout_text = self._truncate((stdout_raw or b"").decode("utf-8", errors="replace"), self._output_limit)
        stderr_text = self._truncate((stderr_raw or b"").decode("utf-8", errors="replace"), self._output_limit)
        return (
            f"command={cmd}\n"
            f"workdir={cwd or ''}\n"
            f"exit_code={int(proc.returncode or 0)}\n"
            f"stdout:\n{stdout_text}\n"
            f"stderr:\n{stderr_text}"
        )

