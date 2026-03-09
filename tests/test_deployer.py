from __future__ import annotations

import json
import shlex
import sys
import time
from pathlib import Path

from drost.deployer.config import DeployerConfig
from drost.deployer.main import main
from drost.deployer.state import DeployerStateStore
from drost.deployer.supervisor import DeployerSupervisor


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


def test_deployer_cli_run_tracks_short_lived_child(tmp_path: Path, capsys) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    state_dir = workspace_dir / "deployer"
    marker = tmp_path / "cli-marker.txt"
    script = tmp_path / "cli-child.py"
    _write_child_script(script, immediate_exit=True)
    config_path = state_dir / "config.toml"
    state_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        "\n".join(
            [
                "[deployer]",
                f'repo_root = "{repo_root.resolve()}"',
                f'workspace_dir = "{workspace_dir.resolve()}"',
                f'state_dir = "{state_dir.resolve()}"',
                f'start_command = "{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(marker))}"',
                "",
            ]
        ),
        encoding="utf-8",
    )

    code = main(
        [
            "--repo-root",
            str(repo_root),
            "--workspace-dir",
            str(workspace_dir),
            "--state-dir",
            str(state_dir),
            "--config-path",
            str(config_path),
            "run",
            "--json",
        ]
    )

    out = capsys.readouterr().out
    payload = json.loads(out)

    assert code == 0
    assert payload["state"] == "idle"
    assert payload["repo_root"] == str(repo_root.resolve())
    assert marker.exists()

    events = state_dir.joinpath("events.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert events
    event_types = [json.loads(line)["event_type"] for line in events]
    assert "deployer_started" in event_types
    assert "child_started" in event_types


def _write_child_script(path: Path, *, immediate_exit: bool = False) -> None:
    body = [
        "from __future__ import annotations",
        "import signal",
        "import sys",
        "import time",
        "from pathlib import Path",
        "",
        "marker = Path(sys.argv[1])",
        "marker.write_text('started', encoding='utf-8')",
    ]
    if immediate_exit:
        body.extend(["", "raise SystemExit(0)"])
    else:
        body.extend(
            [
                "",
                "running = True",
                "",
                "def _stop(signum, frame):",
                "    _ = signum, frame",
                "    global running",
                "    running = False",
                "",
                "signal.signal(signal.SIGTERM, _stop)",
                "signal.signal(signal.SIGINT, _stop)",
                "",
                "while running:",
                "    time.sleep(0.05)",
            ]
        )
    path.write_text("\n".join(body) + "\n", encoding="utf-8")


def test_deployer_supervisor_start_stop_restart_lifecycle(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    marker = tmp_path / "marker.txt"
    script = tmp_path / "child.py"
    _write_child_script(script)

    start_command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(marker))}"
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    config.start_command = start_command
    store = DeployerStateStore(config)
    store.bootstrap()
    supervisor = DeployerSupervisor(store)

    started = supervisor.start_child()
    assert started["state"] == "running"
    assert isinstance(started["child_pid"], int)

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not marker.exists():
        time.sleep(0.05)
    assert marker.exists()

    restarted = supervisor.restart_child()
    assert restarted["state"] == "running"
    assert isinstance(restarted["child_pid"], int)

    stopped = supervisor.stop_child()
    assert stopped["state"] == "idle"
    assert stopped["child_pid"] is None
    assert stopped["child_exited_at"]

    events = store.events_path.read_text(encoding="utf-8")
    assert "child_started" in events
    assert "child_restarting" in events
    assert "child_stopped" in events


def test_deployer_run_forever_tracks_short_lived_child_exit(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    marker = tmp_path / "marker.txt"
    script = tmp_path / "child_exit.py"
    _write_child_script(script, immediate_exit=True)

    start_command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(marker))}"
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    config.start_command = start_command
    store = DeployerStateStore(config)
    store.bootstrap()
    supervisor = DeployerSupervisor(store)

    returncode = supervisor.run_forever()
    status = store.read_status()

    assert returncode == 0
    assert marker.exists()
    assert status["state"] == "idle"
    assert status["child_pid"] is None
    assert status["child_exited_at"]
