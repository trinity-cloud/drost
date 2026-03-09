from __future__ import annotations

import json
from pathlib import Path

from drost.deployer.config import DeployerConfig
from drost.deployer.main import main
from drost.deployer.state import DeployerStateStore


def test_deployer_bootstrap_creates_external_state(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    state_dir = workspace_dir / "deployer"

    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=workspace_dir,
        state_dir=state_dir,
    )
    store = DeployerStateStore(config)
    store.bootstrap()

    assert config.config_path.exists()
    assert store.requests_dir.exists()
    assert store.locks_dir.exists()
    assert store.status_path.exists()
    assert store.known_good_path.exists()
    assert store.events_path.exists()


def test_deployer_event_log_and_status_round_trip(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
    )
    store = DeployerStateStore(config)
    store.bootstrap()

    status = store.read_status()
    status["state"] = "healthy"
    status["active_commit"] = "abc123"
    written = store.write_status(status)
    event = store.append_event("deployer_started", active_commit="abc123")

    assert written["state"] == "healthy"
    assert written["active_commit"] == "abc123"
    assert event["event_type"] == "deployer_started"

    events = store.events_path.read_text(encoding="utf-8").strip().splitlines()
    assert events
    assert json.loads(events[-1])["active_commit"] == "abc123"


def test_deployer_cli_run_bootstraps_status_and_event(tmp_path: Path, capsys) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    state_dir = workspace_dir / "deployer"

    code = main(
        [
            "--repo-root",
            str(repo_root),
            "--workspace-dir",
            str(workspace_dir),
            "--state-dir",
            str(state_dir),
            "run",
            "--json",
        ]
    )

    out = capsys.readouterr().out
    payload = json.loads(out)

    assert code == 0
    assert payload["state"] == "idle"
    assert payload["repo_root"] == str(repo_root.resolve())

    events = state_dir.joinpath("events.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert events
    assert json.loads(events[-1])["event_type"] == "deployer_started"
