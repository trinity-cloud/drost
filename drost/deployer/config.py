from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _resolve_path(value: str | Path) -> Path:
    return Path(value).expanduser().resolve()


LEGACY_CHILD_START_COMMANDS = {"uv run drost", "drost"}


def _normalize_child_start_command(value: str) -> str:
    cleaned = str(value or "").strip() or "uv run drost-gateway"
    if cleaned in LEGACY_CHILD_START_COMMANDS:
        return "uv run drost-gateway"
    return cleaned


@dataclass(slots=True)
class DeployerConfig:
    repo_root: Path
    workspace_dir: Path
    state_dir: Path
    config_path: Path
    start_command: str
    health_url: str
    startup_grace_seconds: float
    health_timeout_seconds: float
    request_poll_interval_seconds: float
    known_good_ref_name: str

    @classmethod
    def load(
        cls,
        *,
        repo_root: str | Path | None = None,
        workspace_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
        config_path: str | Path | None = None,
    ) -> DeployerConfig:
        resolved_workspace_dir = _resolve_path(
            workspace_dir or os.environ.get("DROST_WORKSPACE_DIR") or "~/.drost"
        )
        resolved_state_dir = _resolve_path(state_dir or (resolved_workspace_dir / "deployer"))
        resolved_config_path = _resolve_path(config_path or (resolved_state_dir / "config.toml"))

        defaults: dict[str, Any] = {
            "repo_root": str(
                _resolve_path(repo_root or os.environ.get("DROST_REPO_ROOT") or Path.cwd())
            ),
            "workspace_dir": str(resolved_workspace_dir),
            "state_dir": str(resolved_state_dir),
            "start_command": os.environ.get("DROST_DEPLOYER_START_COMMAND", "uv run drost-gateway"),
            "health_url": os.environ.get("DROST_DEPLOYER_HEALTH_URL", "http://127.0.0.1:8766/health"),
            "startup_grace_seconds": float(os.environ.get("DROST_DEPLOYER_STARTUP_GRACE_SECONDS", "2.0")),
            "health_timeout_seconds": float(os.environ.get("DROST_DEPLOYER_HEALTH_TIMEOUT_SECONDS", "20.0")),
            "request_poll_interval_seconds": float(
                os.environ.get("DROST_DEPLOYER_REQUEST_POLL_INTERVAL_SECONDS", "1.0")
            ),
            "known_good_ref_name": os.environ.get(
                "DROST_DEPLOYER_KNOWN_GOOD_REF_NAME",
                "drost-known-good",
            ),
        }

        file_values: dict[str, Any] = {}
        if resolved_config_path.exists():
            parsed = tomllib.loads(resolved_config_path.read_text(encoding="utf-8"))
            deployer_section = parsed.get("deployer")
            if isinstance(deployer_section, dict):
                file_values = dict(deployer_section)

        merged = {**defaults, **file_values}
        return cls(
            repo_root=_resolve_path(merged["repo_root"]),
            workspace_dir=_resolve_path(merged["workspace_dir"]),
            state_dir=_resolve_path(merged["state_dir"]),
            config_path=resolved_config_path,
            start_command=_normalize_child_start_command(str(merged["start_command"])),
            health_url=str(merged["health_url"]).strip() or "http://127.0.0.1:8766/health",
            startup_grace_seconds=max(0.0, float(merged["startup_grace_seconds"])),
            health_timeout_seconds=max(1.0, float(merged["health_timeout_seconds"])),
            request_poll_interval_seconds=max(0.1, float(merged["request_poll_interval_seconds"])),
            known_good_ref_name=str(merged["known_good_ref_name"]).strip() or "drost-known-good",
        )

    def render_toml(self) -> str:
        return "\n".join(
            [
                "[deployer]",
                f'repo_root = "{self.repo_root}"',
                f'workspace_dir = "{self.workspace_dir}"',
                f'state_dir = "{self.state_dir}"',
                f'start_command = "{_normalize_child_start_command(self.start_command)}"',
                f'health_url = "{self.health_url}"',
                f"startup_grace_seconds = {self.startup_grace_seconds}",
                f"health_timeout_seconds = {self.health_timeout_seconds}",
                f"request_poll_interval_seconds = {self.request_poll_interval_seconds}",
                f'known_good_ref_name = "{self.known_good_ref_name}"',
                "",
            ]
        )
