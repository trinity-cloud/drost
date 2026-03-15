from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.config import Settings
from drost.deployer.client import DeployerClient

_TOOLS_HEADER = "## Machine-Managed Operational Truths"
_TOOLS_START = "<!-- drost:operational-truths:start -->"
_TOOLS_END = "<!-- drost:operational-truths:end -->"
_MEMORY_HEADER = "## Machine-Managed Operational Lessons"
_MEMORY_START = "<!-- drost:operational-lessons:start -->"
_MEMORY_END = "<!-- drost:operational-lessons:end -->"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _exists(path_or_command: str) -> bool:
    cleaned = str(path_or_command or "").strip()
    if not cleaned:
        return False
    candidate = Path(cleaned).expanduser()
    if candidate.exists():
        return True
    return shutil.which(cleaned) is not None


class OperationalTruthStore:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._workspace_dir = settings.workspace_dir.expanduser()
        self._state_dir = self._workspace_dir / "state"
        self._tools_path = self._workspace_dir / "TOOLS.md"
        self._memory_path = self._workspace_dir / "MEMORY.md"
        self._snapshot_path = self._state_dir / "operational-self-model.json"

    @property
    def snapshot_path(self) -> Path:
        return self._snapshot_path

    def refresh(self) -> dict[str, Any]:
        self._state_dir.mkdir(parents=True, exist_ok=True)
        deployer = DeployerClient.from_runtime(
            repo_root=str(self._settings.repo_root),
            workspace_dir=str(self._settings.workspace_dir),
        ).status()
        snapshot = {
            "refreshed_at": _utc_now(),
            "runtime": {
                "repo_root": str(self._settings.repo_root),
                "workspace_root": str(self._settings.workspace_dir),
                "launch_mode": str(self._settings.runtime_launch_mode),
                "start_command": str(self._settings.runtime_start_command),
                "gateway_health_url": str(self._settings.gateway_health_url),
            },
            "deployer": {
                "state": str(deployer.get("state") or ""),
                "repo_head_commit": str(deployer.get("repo_head_commit") or ""),
                "active_commit": str(deployer.get("active_commit") or ""),
                "known_good_commit": str(deployer.get("known_good_commit") or ""),
                "last_error": str(deployer.get("last_error") or ""),
                "last_noop_reason": str(deployer.get("last_noop_reason") or ""),
            },
            "workers": {
                "tmux_binary": str(self._settings.worker_tmux_binary_path),
                "tmux_available": _exists(self._settings.worker_tmux_binary_path),
                "codex_binary": str(self._settings.worker_codex_binary_path),
                "codex_available": _exists(self._settings.worker_codex_binary_path),
                "claude_binary": str(self._settings.worker_claude_binary_path),
                "claude_available": _exists(self._settings.worker_claude_binary_path),
                "single_write_job_per_repo": True,
            },
            "lessons": [
                "Deployer requests are intent, not proof of live rollout. Verify active_commit and health before reporting success.",
                "Promote is immediate and synchronous. It is not a queued deployer request.",
                "Use worker_request and worker_status for Codex/Claude supervision instead of shell/tmux polling.",
                "Foreground turns should inspect, launch, review, and report worker jobs rather than babysitting them.",
            ],
        }
        self._write_section(
            self._tools_path,
            header=_TOOLS_HEADER,
            start_marker=_TOOLS_START,
            end_marker=_TOOLS_END,
            body=self._render_tools_section(snapshot),
        )
        self._write_section(
            self._memory_path,
            header=_MEMORY_HEADER,
            start_marker=_MEMORY_START,
            end_marker=_MEMORY_END,
            body=self._render_memory_section(snapshot),
        )
        self._snapshot_path.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return snapshot

    def status(self) -> dict[str, Any]:
        try:
            payload = json.loads(self._snapshot_path.read_text(encoding="utf-8"))
        except Exception:
            return self.refresh()
        return payload if isinstance(payload, dict) else self.refresh()

    @staticmethod
    def _render_tools_section(snapshot: dict[str, Any]) -> str:
        runtime = dict(snapshot.get("runtime") or {})
        deployer = dict(snapshot.get("deployer") or {})
        workers = dict(snapshot.get("workers") or {})
        lines = [
            _TOOLS_HEADER,
            _TOOLS_START,
            "### Runtime",
            f"- repo_root={runtime.get('repo_root') or ''}",
            f"- workspace_root={runtime.get('workspace_root') or ''}",
            f"- launch_mode={runtime.get('launch_mode') or ''}",
            f"- start_command={runtime.get('start_command') or ''}",
            f"- gateway_health_url={runtime.get('gateway_health_url') or ''}",
            "",
            "### Deployer",
            "- deploy requests must be verified against active_commit and health before being reported as live.",
            "- promote is immediate and synchronous, not a queued request.",
            f"- repo_head_commit={deployer.get('repo_head_commit') or ''}",
            f"- active_commit={deployer.get('active_commit') or ''}",
            f"- known_good_commit={deployer.get('known_good_commit') or ''}",
            f"- deployer_state={deployer.get('state') or ''}",
            f"- last_noop_reason={deployer.get('last_noop_reason') or ''}",
            "",
            "### Worker Supervision",
            "- use worker_request and worker_status for Codex / Claude supervision instead of shell_execute or tmux polling.",
            "- allow at most one write-capable active worker per repo root.",
            f"- tmux_binary={workers.get('tmux_binary') or ''} available={workers.get('tmux_available')}",
            f"- codex_binary={workers.get('codex_binary') or ''} available={workers.get('codex_available')}",
            f"- claude_binary={workers.get('claude_binary') or ''} available={workers.get('claude_available')}",
            _TOOLS_END,
        ]
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _render_memory_section(snapshot: dict[str, Any]) -> str:
        lines = [_MEMORY_HEADER, _MEMORY_START]
        for lesson in list(snapshot.get("lessons") or []):
            cleaned = str(lesson or "").strip()
            if cleaned:
                lines.append(f"- {cleaned}")
        lines.append(_MEMORY_END)
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _write_section(
        path: Path,
        *,
        header: str,
        start_marker: str,
        end_marker: str,
        body: str,
    ) -> None:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        start = existing.find(header)
        marker_start = existing.find(start_marker)
        marker_end = existing.find(end_marker)
        if start != -1 and marker_start != -1 and marker_end != -1 and start <= marker_start < marker_end:
            end = marker_end + len(end_marker)
            suffix = existing[end:]
            if suffix.startswith("\n"):
                suffix = suffix[1:]
            prefix = existing[:start].rstrip()
            updated = body if not prefix else prefix + "\n\n" + body
            if suffix.strip():
                updated += "\n" + suffix.lstrip("\n")
            path.write_text(updated, encoding="utf-8")
            return

        cleaned = existing.rstrip()
        updated = body if not cleaned else cleaned + "\n\n" + body
        path.write_text(updated, encoding="utf-8")
