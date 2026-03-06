from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

BOOTSTRAP_COMPLETE_MARKER = ".bootstrap-complete"
DEFAULT_MAX_FILE_CHARS = 20_000


def _strip_frontmatter(content: str) -> str:
    if not content.startswith("---"):
        return content
    end_index = content.find("\n---", 3)
    if end_index == -1:
        return content
    trimmed = content[end_index + len("\n---") :]
    return trimmed.lstrip()


def _is_safe_workspace_relative(path: Path) -> bool:
    if path.is_absolute():
        return False
    return ".." not in path.parts


@dataclass(slots=True)
class WorkspaceContext:
    path: Path
    agents_md: str | None = None
    bootstrap_md: str | None = None
    soul_md: str | None = None
    identity_md: str | None = None
    user_md: str | None = None
    tools_md: str | None = None
    heartbeat_md: str | None = None
    memory_md: str | None = None
    daily_memory: list[tuple[str, str]] = field(default_factory=list)
    extra_files: list[tuple[str, str]] = field(default_factory=list)
    bootstrap_complete: bool = False

    @property
    def bootstrap_active(self) -> bool:
        return bool(self.bootstrap_md) and not self.bootstrap_complete

    @property
    def agent_name(self) -> str | None:
        if not self.identity_md:
            return None
        for line in self.identity_md.splitlines():
            lowered = line.lower().strip()
            if lowered.startswith("agent name:") or lowered.startswith("name:"):
                return line.split(":", 1)[1].strip().strip("*").strip() or None
        return None


class WorkspaceLoader:
    def __init__(
        self,
        workspace_path: str | Path,
        *,
        max_file_chars: int = DEFAULT_MAX_FILE_CHARS,
    ) -> None:
        self.workspace_path = Path(workspace_path).expanduser()
        self.max_file_chars = max(1_000, int(max_file_chars))

    def load(
        self,
        *,
        extra_files: list[str] | None = None,
        include_memory_md: bool = True,
        include_heartbeat: bool = False,
    ) -> WorkspaceContext:
        ctx = WorkspaceContext(
            path=self.workspace_path,
            bootstrap_complete=(self.workspace_path / BOOTSTRAP_COMPLETE_MARKER).exists(),
        )
        ctx.agents_md = self._load_file("AGENTS.md")
        ctx.bootstrap_md = self._load_file("BOOTSTRAP.md")
        ctx.soul_md = self._load_file("SOUL.md")
        ctx.identity_md = self._load_file("IDENTITY.md")
        ctx.user_md = self._load_file("USER.md")
        ctx.tools_md = self._load_file("TOOLS.md")
        if include_heartbeat:
            ctx.heartbeat_md = self._load_file("HEARTBEAT.md")
        if include_memory_md:
            ctx.memory_md = self._load_file("MEMORY.md")
        ctx.daily_memory = self._load_daily_memory()
        ctx.extra_files = self._load_extra_files(extra_files or [])
        return ctx

    def _load_file(self, relative_path: str) -> str | None:
        rel = Path(relative_path)
        if not _is_safe_workspace_relative(rel):
            return None
        path = self.workspace_path / rel
        if not path.exists() or not path.is_file():
            return None
        try:
            body = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
        body = _strip_frontmatter(body).strip()
        if not body:
            return None
        if len(body) > self.max_file_chars:
            return body[: self.max_file_chars].rstrip() + "\n\n[TRUNCATED]"
        return body

    def _load_daily_memory(self) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        candidates = [
            self.workspace_path / "memory" / "daily",
            self.workspace_path / "memory",
        ]
        seen: set[str] = set()
        today = date.today()
        for base in candidates:
            if not base.exists() or not base.is_dir():
                continue
            for days_ago in [0, 1]:
                target_date = today - timedelta(days=days_ago)
                filename = f"{target_date.isoformat()}.md"
                if filename in seen:
                    continue
                path = base / filename
                if not path.exists() or not path.is_file():
                    continue
                body = self._load_file(path.relative_to(self.workspace_path).as_posix())
                if not body:
                    continue
                relative_name = path.relative_to(self.workspace_path).as_posix()
                result.append((relative_name, body))
                seen.add(filename)
        return result

    def _load_extra_files(self, extra_files: list[str]) -> list[tuple[str, str]]:
        standard = {
            "AGENTS.md",
            "BOOTSTRAP.md",
            "SOUL.md",
            "IDENTITY.md",
            "USER.md",
            "TOOLS.md",
            "HEARTBEAT.md",
            "MEMORY.md",
        }
        loaded: list[tuple[str, str]] = []
        seen: set[str] = set()
        for raw_name in extra_files:
            rel = str(raw_name or "").strip()
            if not rel or rel in standard or rel in seen:
                continue
            seen.add(rel)
            body = self._load_file(rel)
            if body:
                loaded.append((rel, body))
        return loaded
