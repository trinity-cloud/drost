from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from drost.deployer.config import DeployerConfig


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class DeployerStateStore:
    config: DeployerConfig

    @property
    def requests_dir(self) -> Path:
        return self.config.state_dir / "requests"

    @property
    def pending_requests_dir(self) -> Path:
        return self.requests_dir / "pending"

    @property
    def inflight_requests_dir(self) -> Path:
        return self.requests_dir / "inflight"

    @property
    def processed_requests_dir(self) -> Path:
        return self.requests_dir / "processed"

    @property
    def failed_requests_dir(self) -> Path:
        return self.requests_dir / "failed"

    @property
    def locks_dir(self) -> Path:
        return self.config.state_dir / "locks"

    @property
    def run_lock_path(self) -> Path:
        return self.locks_dir / "deployer-run.lock"

    @property
    def logs_dir(self) -> Path:
        return self.config.state_dir / "logs"

    @property
    def status_path(self) -> Path:
        return self.config.state_dir / "status.json"

    @property
    def known_good_path(self) -> Path:
        return self.config.state_dir / "known_good.json"

    @property
    def events_path(self) -> Path:
        return self.config.state_dir / "events.jsonl"

    def bootstrap(self) -> None:
        self.config.state_dir.mkdir(parents=True, exist_ok=True)
        self.requests_dir.mkdir(parents=True, exist_ok=True)
        self.pending_requests_dir.mkdir(parents=True, exist_ok=True)
        self.inflight_requests_dir.mkdir(parents=True, exist_ok=True)
        self.processed_requests_dir.mkdir(parents=True, exist_ok=True)
        self.failed_requests_dir.mkdir(parents=True, exist_ok=True)
        self.locks_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        if not self.config.config_path.exists():
            self.config.config_path.write_text(self.config.render_toml(), encoding="utf-8")
        else:
            config_text = self.config.config_path.read_text(encoding="utf-8")
            if 'start_command = "uv run drost"' in config_text or 'start_command = "drost"' in config_text:
                self.config.config_path.write_text(self.config.render_toml(), encoding="utf-8")
        if not self.status_path.exists():
            self.write_status(self.default_status())
        if not self.known_good_path.exists():
            self.write_known_good(self.default_known_good())
        if not self.events_path.exists():
            self.events_path.touch()

    def default_status(self) -> dict[str, Any]:
        return {
            "mode": "skeleton",
            "state": "idle",
            "repo_root": str(self.config.repo_root),
            "workspace_dir": str(self.config.workspace_dir),
            "state_dir": str(self.config.state_dir),
            "active_commit": "",
            "known_good_commit": "",
            "active_request_id": "",
            "active_request_type": "",
            "child_pid": None,
            "child_started_at": "",
            "child_exited_at": "",
            "child_returncode": None,
            "last_health_checked_at": "",
            "last_health_status_code": None,
            "last_health_body": "",
            "last_health_ok_at": "",
            "last_request_id": "",
            "pending_request_ids": [],
            "last_error": "",
            "updated_at": _utc_now(),
        }

    @staticmethod
    def default_known_good() -> dict[str, Any]:
        return {
            "ref_name": "",
            "commit": "",
            "promoted_at": "",
            "startup_duration_ms": None,
            "health_url": "",
            "notes": "",
        }

    def read_status(self) -> dict[str, Any]:
        if not self.status_path.exists():
            return self.default_status()
        return json.loads(self.status_path.read_text(encoding="utf-8"))

    def write_status(self, status: dict[str, Any]) -> dict[str, Any]:
        payload = dict(status)
        payload["updated_at"] = _utc_now()
        self.status_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return payload

    def read_known_good(self) -> dict[str, Any]:
        if not self.known_good_path.exists():
            return self.default_known_good()
        return json.loads(self.known_good_path.read_text(encoding="utf-8"))

    def write_known_good(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = dict(payload)
        self.known_good_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return data

    def append_event(self, event_type: str, **fields: Any) -> dict[str, Any]:
        payload = {
            "timestamp": _utc_now(),
            "event_type": str(event_type).strip(),
            **fields,
        }
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
        return payload
