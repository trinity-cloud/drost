from __future__ import annotations

import json
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path

from drost.deployer.config import DeployerConfig
from drost.deployer.main import main
from drost.deployer.request_queue import DeployerRequestQueue
from drost.deployer.rollout import DeployerRolloutManager
from drost.deployer.run_lock import DeployerRunLock, follow_existing_logs
from drost.deployer.service import DeployerService
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
    assert store.pending_requests_dir.exists()
    assert store.inflight_requests_dir.exists()
    assert store.processed_requests_dir.exists()
    assert store.failed_requests_dir.exists()
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


def test_deployer_state_store_recovers_corrupted_status_file(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
    )
    store = DeployerStateStore(config)
    store.bootstrap()

    good = store.default_status()
    good["state"] = "healthy"
    good["active_commit"] = "abc123"
    corrupted = json.dumps(good, indent=2, sort_keys=True) + '\n"/tmp/workspace"\n}\n'
    store.status_path.write_text(corrupted, encoding="utf-8")

    recovered = store.read_status()

    assert recovered["state"] == "healthy"
    assert recovered["active_commit"] == "abc123"
    reloaded = json.loads(store.status_path.read_text(encoding="utf-8"))
    assert reloaded["active_commit"] == "abc123"


def test_deployer_cli_request_enqueue_tracks_pending_request(tmp_path: Path, capsys) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    state_dir = workspace_dir / "deployer"
    config_path = state_dir / "config.toml"
    state_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        "\n".join(
            [
                "[deployer]",
                f'repo_root = "{repo_root.resolve()}"',
                f'workspace_dir = "{workspace_dir.resolve()}"',
                f'state_dir = "{state_dir.resolve()}"',
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
            "request",
            "restart",
            "--requested-by",
            "test",
            "--reason",
            "cli queue",
            "--json",
        ]
    )

    out = capsys.readouterr().out
    payload = json.loads(out)

    assert code == 0
    assert payload["type"] == "restart"
    assert payload["requested_by"] == "test"
    assert payload["reason"] == "cli queue"
    assert payload["pending_request_ids"] == [payload["request_id"]]

    events = state_dir.joinpath("events.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert events
    event_types = [json.loads(line)["event_type"] for line in events]
    assert "request_received" in event_types


def test_deployer_cli_operator_views_render_config_events_and_requests(tmp_path: Path, capsys) -> None:
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
    queue = DeployerRequestQueue(store)
    queue.enqueue("restart", requested_by="test", reason="inspect")

    config_code = main(
        [
            "--repo-root",
            str(repo_root),
            "--workspace-dir",
            str(workspace_dir),
            "--state-dir",
            str(state_dir),
            "config",
            "--json",
        ]
    )
    config_out = json.loads(capsys.readouterr().out)
    assert config_code == 0
    assert config_out["repo_root"] == str(repo_root.resolve())

    requests_code = main(
        [
            "--repo-root",
            str(repo_root),
            "--workspace-dir",
            str(workspace_dir),
            "--state-dir",
            str(state_dir),
            "requests",
            "--json",
        ]
    )
    requests_out = json.loads(capsys.readouterr().out)
    assert requests_code == 0
    assert requests_out["pending"][0]["type"] == "restart"

    events_code = main(
        [
            "--repo-root",
            str(repo_root),
            "--workspace-dir",
            str(workspace_dir),
            "--state-dir",
            str(state_dir),
            "events",
            "--limit",
            "5",
            "--json",
        ]
    )
    events_out = json.loads(capsys.readouterr().out)
    assert events_code == 0
    assert any(row["event_type"] == "request_received" for row in events_out)


def _write_child_script(
    path: Path,
    *,
    immediate_exit: bool = False,
    stdout_text: str = "",
    stderr_text: str = "",
) -> None:
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
    if stdout_text:
        body.append(f"print({stdout_text!r}, flush=True)")
    if stderr_text:
        body.append(f"print({stderr_text!r}, file=sys.stderr, flush=True)")
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


def _write_health_server_script(path: Path) -> None:
    body = [
        "from __future__ import annotations",
        "import json",
        "import signal",
        "import sys",
        "import threading",
        "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
        "from pathlib import Path",
        "",
        "repo_root = Path(sys.argv[1])",
        "port = int(sys.argv[2])",
        "marker = Path(sys.argv[3])",
        "marker.write_text('started', encoding='utf-8')",
        "",
        "class Handler(BaseHTTPRequestHandler):",
        "    def _mode(self):",
        "        return repo_root.joinpath('health.txt').read_text(encoding='utf-8').strip()",
        "",
        "    def _send_json(self, status, payload):",
        "        self.send_response(status)",
        "        self.send_header('Content-Type', 'application/json')",
        "        self.end_headers()",
        "        self.wfile.write(json.dumps(payload).encode('utf-8'))",
        "",
        "    def do_GET(self):",
        "        mode = self._mode()",
        "        if self.path == '/health':",
        "            if mode == 'ok' or mode == 'runtime_fail' or mode == 'canary_fail':",
        "                payload = {'status': 'ok'}",
        "                self._send_json(200, payload)",
        "            else:",
        "                payload = {'status': 'error', 'mode': mode or 'missing'}",
        "                self._send_json(503, payload)",
        "            return",
        "        if self.path in {'/v1/loops/status', '/v1/mind/status', '/v1/cognition/status'}:",
        "            if mode == 'runtime_fail':",
        "                self._send_json(503, {'ok': False, 'label': 'runtime_surface_failed'})",
        "            else:",
        "                self._send_json(200, {'ok': True, 'path': self.path})",
        "            return",
        "        self.send_response(404)",
        "        self.end_headers()",
        "",
        "    def do_POST(self):",
        "        mode = self._mode()",
        "        if self.path != '/v1/canary/deploy':",
        "            self.send_response(404)",
        "            self.end_headers()",
        "            return",
        "        if mode == 'ok':",
        "            self._send_json(200, {'ok': True, 'label': 'ok'})",
        "        elif mode == 'canary_fail':",
        "            self._send_json(503, {'ok': False, 'label': 'tool_canary_failed'})",
        "        else:",
        "            self._send_json(503, {'ok': False, 'label': 'provider_canary_failed'})",
        "",
        "    def log_message(self, format, *args):",
        "        _ = format, args",
        "        return",
        "",
        "server = ThreadingHTTPServer(('127.0.0.1', port), Handler)",
        "",
        "def _stop(signum, frame):",
        "    _ = signum, frame",
        "    threading.Thread(target=server.shutdown, daemon=True).start()",
        "",
        "signal.signal(signal.SIGTERM, _stop)",
        "signal.signal(signal.SIGINT, _stop)",
        "server.serve_forever(poll_interval=0.1)",
        "server.server_close()",
    ]
    path.write_text("\n".join(body) + "\n", encoding="utf-8")


def _git(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return (result.stdout or "").strip()


def _init_git_repo(repo_root: Path) -> None:
    repo_root.mkdir(parents=True, exist_ok=True)
    _git(repo_root, "init")
    _git(repo_root, "config", "user.name", "Drost Tests")
    _git(repo_root, "config", "user.email", "drost-tests@example.com")


def _commit_health_state(repo_root: Path, *, mode: str, message: str) -> str:
    repo_root.joinpath("health.txt").write_text(mode + "\n", encoding="utf-8")
    repo_root.joinpath("README.md").write_text(message + "\n", encoding="utf-8")
    _git(repo_root, "add", "health.txt", "README.md")
    _git(repo_root, "commit", "-m", message)
    return _git(repo_root, "rev-parse", "HEAD")


def _reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.bind(("127.0.0.1", 0))
        return int(handle.getsockname()[1])


def _wait_for_path(path: Path, *, timeout_seconds: float = 3.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {path}")


def _make_health_rollout_runtime(tmp_path: Path) -> tuple[DeployerConfig, DeployerStateStore, DeployerSupervisor, DeployerRolloutManager]:
    repo_root = tmp_path / "repo"
    _init_git_repo(repo_root)
    port = _reserve_port()
    marker = tmp_path / "health-marker.txt"
    script = tmp_path / "health-child.py"
    _write_health_server_script(script)

    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    config.start_command = (
        f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"
        f" {shlex.quote(str(repo_root))} {int(port)} {shlex.quote(str(marker))}"
    )
    config.health_url = f"http://127.0.0.1:{int(port)}/health"
    config.startup_grace_seconds = 0.1
    config.health_timeout_seconds = 3.0
    config.request_poll_interval_seconds = 0.1
    store = DeployerStateStore(config)
    store.bootstrap()
    supervisor = DeployerSupervisor(store)
    rollout = DeployerRolloutManager(store=store, supervisor=supervisor)
    return config, store, supervisor, rollout


def _make_health_service_runtime(
    tmp_path: Path,
) -> tuple[DeployerConfig, DeployerStateStore, DeployerSupervisor, DeployerRolloutManager, DeployerRequestQueue, DeployerService]:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    queue = DeployerRequestQueue(store)
    service = DeployerService(store=store, supervisor=supervisor, rollout=rollout, queue=queue)
    return config, store, supervisor, rollout, queue, service


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


def test_deployer_supervisor_run_forever_mirrors_child_logs_to_console(tmp_path: Path, capsys) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    marker = tmp_path / "marker.txt"
    script = tmp_path / "child_exit.py"
    _write_child_script(
        script,
        immediate_exit=True,
        stdout_text="child-stdout-line",
        stderr_text="child-stderr-line",
    )

    start_command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {shlex.quote(str(marker))}"
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    config.start_command = start_command
    store = DeployerStateStore(config)
    store.bootstrap()
    supervisor = DeployerSupervisor(store, mirror_child_logs=True)

    returncode = supervisor.run_forever()
    captured = capsys.readouterr()

    assert returncode == 0
    assert "child-stdout-line" in captured.out
    assert "child-stderr-line" in captured.err
    assert "child-stdout-line" in store.logs_dir.joinpath("child.stdout.log").read_text(encoding="utf-8")
    assert "child-stderr-line" in store.logs_dir.joinpath("child.stderr.log").read_text(encoding="utf-8")


def test_deployer_run_lock_is_exclusive(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    store = DeployerStateStore(config)
    store.bootstrap()

    first = DeployerRunLock(store)
    second = DeployerRunLock(store)

    assert first.acquire() is True
    assert second.acquire() is False
    assert first.read_owner()["pid"] > 0
    first.release()
    assert second.acquire() is True
    second.release()


def test_follow_existing_logs_streams_log_files_and_exits_on_signal(tmp_path: Path, monkeypatch, capsys) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    store = DeployerStateStore(config)
    store.bootstrap()

    run_lock = DeployerRunLock(store)
    assert run_lock.acquire() is True
    store.logs_dir.joinpath("child.stdout.log").write_text("stdout-line\n", encoding="utf-8")
    store.logs_dir.joinpath("child.stderr.log").write_text("stderr-line\n", encoding="utf-8")

    owner_message = run_lock.read_owner()
    assert owner_message["pid"] > 0

    original_signal = __import__("signal").signal
    captured_handler = {}

    def _fake_signal(sig, handler):
        captured_handler[int(sig)] = handler
        return original_signal(sig, handler)

    monkeypatch.setattr("signal.signal", _fake_signal)

    def _trigger_stop():
        time.sleep(0.2)
        handler = captured_handler.get(int(signal.SIGINT))
        assert handler is not None
        handler(signal.SIGINT, None)

    import signal
    import threading

    stop_thread = threading.Thread(target=_trigger_stop, daemon=True)
    stop_thread.start()
    try:
        exit_code = follow_existing_logs(store, out=sys.stdout, err=sys.stderr)
    finally:
        run_lock.release()

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "attaching to existing child logs" in captured.err
    assert "stdout-line" in captured.out
    assert "stderr-line" in captured.err


def test_deployer_rollout_promote_and_deploy_candidate_success(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    candidate_commit = _commit_health_state(repo_root, mode="ok", message="candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        started = supervisor.start_child()
        assert started["state"] == "running"
        _wait_for_path(marker)

        promoted = rollout.promote_current()
        assert promoted["state"] == "healthy"
        assert promoted["known_good_commit"] == stable_commit
        assert promoted["last_canary_label"] == "ok"
        assert store.read_known_good()["commit"] == stable_commit

        deployed = rollout.deploy_candidate(candidate_commit)
        assert deployed["state"] == "healthy"
        assert deployed["active_commit"] == candidate_commit
        assert deployed["known_good_commit"] == candidate_commit
        assert deployed["last_canary_label"] == "ok"
        assert _git(repo_root, "rev-parse", "HEAD") == candidate_commit
        assert store.read_known_good()["commit"] == candidate_commit
        assert store.read_known_good()["ref_name"] == f"refs/drost/{config.known_good_ref_name}"

        events = store.events_path.read_text(encoding="utf-8")
        assert "promote_current_succeeded" in events
        assert "deploy_candidate_succeeded" in events
    finally:
        supervisor.stop_child()


def test_deployer_rollout_deploy_candidate_uses_active_runtime_commit_for_noop_check(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    candidate_commit = _commit_health_state(repo_root, mode="ok", message="candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        # Simulate repo HEAD advancing without the supervised runtime rolling forward.
        _git(repo_root, "checkout", "--force", candidate_commit)
        refreshed = supervisor.refresh_status()
        assert refreshed["repo_head_commit"] == candidate_commit
        assert refreshed["active_commit"] == stable_commit

        deployed = rollout.deploy_candidate(candidate_commit)
        assert deployed["state"] == "healthy"
        assert deployed["repo_head_commit"] == candidate_commit
        assert deployed["active_commit"] == candidate_commit
        assert deployed["known_good_commit"] == candidate_commit
        assert deployed["last_noop_reason"] == ""

        events = store.events_path.read_text(encoding="utf-8")
        assert "deploy_candidate_started" in events
        assert "deploy_candidate_succeeded" in events
        assert "deploy_candidate_noop" not in events
    finally:
        supervisor.stop_child()


def test_deployer_rollout_promote_uses_active_runtime_commit_not_repo_head(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    candidate_commit = _commit_health_state(repo_root, mode="ok", message="candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)

        # Repo HEAD moves, but the active runtime is still serving stable_commit.
        _git(repo_root, "checkout", "--force", candidate_commit)
        refreshed = supervisor.refresh_status()
        assert refreshed["repo_head_commit"] == candidate_commit
        assert refreshed["active_commit"] == stable_commit

        promoted = rollout.promote_current()
        assert promoted["state"] == "healthy"
        assert promoted["repo_head_commit"] == candidate_commit
        assert promoted["active_commit"] == stable_commit
        assert promoted["known_good_commit"] == stable_commit
        assert store.read_known_good()["commit"] == stable_commit
    finally:
        supervisor.stop_child()


def test_deployer_rollout_failed_candidate_rolls_back_to_known_good(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    bad_commit = _commit_health_state(repo_root, mode="fail", message="bad-candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        deployed = rollout.deploy_candidate(bad_commit)
        assert deployed["state"] == "healthy"
        assert deployed["active_commit"] == stable_commit
        assert deployed["known_good_commit"] == stable_commit
        assert "rolled back" in str(deployed["last_error"])
        assert _git(repo_root, "rev-parse", "HEAD") == stable_commit
        assert store.read_known_good()["commit"] == stable_commit

        events = store.events_path.read_text(encoding="utf-8")
        assert "deploy_candidate_failed_validation" in events
        assert "rollback_succeeded" in events
    finally:
        supervisor.stop_child()


def test_deployer_rollout_failed_canary_rolls_back_to_known_good(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    bad_commit = _commit_health_state(repo_root, mode="canary_fail", message="bad-canary")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        deployed = rollout.deploy_candidate(bad_commit)
        assert deployed["state"] == "healthy"
        assert deployed["active_commit"] == stable_commit
        assert deployed["known_good_commit"] == stable_commit
        assert "tool_canary_failed" in str(deployed["last_error"])
        assert _git(repo_root, "rev-parse", "HEAD") == stable_commit

        events = store.events_path.read_text(encoding="utf-8")
        assert "deploy_candidate_failed_validation" in events
        assert "rollback_succeeded" in events
    finally:
        supervisor.stop_child()


def test_deployer_rollout_enters_degraded_mode_when_rollback_fails(tmp_path: Path) -> None:
    config, store, supervisor, rollout = _make_health_rollout_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    bad_commit = _commit_health_state(repo_root, mode="fail", message="bad-candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    exit_script = tmp_path / "exit-child.py"
    exit_marker = tmp_path / "exit-marker.txt"
    _write_child_script(exit_script, immediate_exit=True)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        config.start_command = (
            f"{shlex.quote(sys.executable)} {shlex.quote(str(exit_script))} {shlex.quote(str(exit_marker))}"
        )
        config.startup_grace_seconds = 0.0
        config.health_timeout_seconds = 1.0

        deployed = rollout.deploy_candidate(bad_commit)
        assert deployed["state"] == "degraded"
        assert deployed["active_commit"] == stable_commit
        assert "rollback validation failed" in str(deployed["last_error"])
        assert _git(repo_root, "rev-parse", "HEAD") == stable_commit

        events = store.events_path.read_text(encoding="utf-8")
        assert "deploy_candidate_failed_validation" in events
        assert "rollback_failed" in events
    finally:
        supervisor.stop_child()


def test_deployer_request_queue_deduplicates_pending_restart_requests(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    store = DeployerStateStore(config)
    store.bootstrap()
    queue = DeployerRequestQueue(store)

    first = queue.enqueue("restart", requested_by="test", reason="first")
    second = queue.enqueue("restart", requested_by="test", reason="duplicate")

    assert first.request_id == second.request_id
    assert queue.pending_request_ids() == [first.request_id]
    assert len(list(store.pending_requests_dir.glob("*.json"))) == 1


def test_deployer_request_queue_survives_restart_with_inflight_request(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        state_dir=tmp_path / "workspace" / "deployer",
    )
    store = DeployerStateStore(config)
    store.bootstrap()
    queue = DeployerRequestQueue(store)

    request = queue.enqueue("restart", requested_by="test", reason="recover")
    claimed = queue.claim_next()
    assert claimed is not None
    assert claimed.request_id == request.request_id

    store_after_restart = DeployerStateStore(config)
    queue_after_restart = DeployerRequestQueue(store_after_restart)
    claimed_again = queue_after_restart.claim_next()

    assert claimed_again is not None
    assert claimed_again.request_id == request.request_id
    assert len(list(store.inflight_requests_dir.glob("*.json"))) == 1


def test_deployer_service_processes_requests_fifo(tmp_path: Path) -> None:
    config, store, supervisor, rollout, queue, service = _make_health_service_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    candidate_commit = _commit_health_state(repo_root, mode="ok", message="candidate")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        restart_request = queue.enqueue("restart", requested_by="test", reason="queue restart")
        deploy_request = queue.enqueue(
            "deploy_candidate",
            requested_by="test",
            reason="queue deploy",
            candidate_ref=candidate_commit,
        )

        first = service.process_next_request()
        assert first is not None
        assert first["state"] == "healthy"
        assert first["active_commit"] == stable_commit
        assert store.read_status()["last_request_id"] == restart_request.request_id
        assert queue.pending_request_ids() == [deploy_request.request_id]

        second = service.process_next_request()
        assert second is not None
        assert second["state"] == "healthy"
        assert second["active_commit"] == candidate_commit
        assert store.read_status()["last_request_id"] == deploy_request.request_id
        assert queue.pending_request_ids() == []
        assert len(list(store.processed_requests_dir.glob("*.json"))) == 2

        events = store.events_path.read_text(encoding="utf-8")
        assert "request_received" in events
        assert "request_started" in events
        assert "request_completed" in events
    finally:
        supervisor.stop_child()


def test_deployer_service_failed_request_restores_verified_runtime_state(tmp_path: Path) -> None:
    config, store, supervisor, rollout, queue, service = _make_health_service_runtime(tmp_path)
    repo_root = config.repo_root
    marker = tmp_path / "health-marker.txt"

    stable_commit = _commit_health_state(repo_root, mode="ok", message="stable")
    _git(repo_root, "checkout", "--force", stable_commit)

    try:
        supervisor.start_child()
        _wait_for_path(marker)
        rollout.promote_current()

        repo_root.joinpath("DIRTY.txt").write_text("dirty\n", encoding="utf-8")
        queue.enqueue("deploy_candidate", requested_by="test", reason="dirty tree", candidate_ref=stable_commit)

        result = service.process_next_request()

        assert result is not None
        assert result["state"] == "healthy"
        assert result["active_request_id"] == ""
        assert "repo worktree must be clean" in str(result["last_error"])
        assert not list(store.pending_requests_dir.glob("*.json"))
        assert list(store.failed_requests_dir.glob("*.json"))
    finally:
        supervisor.stop_child()


def test_deployer_service_reclaims_child_from_stale_supervisor(tmp_path: Path) -> None:
    config, store, supervisor, _rollout, _queue, service = _make_health_service_runtime(tmp_path)
    _commit_health_state(config.repo_root, mode="ok", message="stable")
    marker = tmp_path / "health-marker.txt"

    try:
        started = supervisor.start_child()
        _wait_for_path(marker)
        first_child_pid = int(started["child_pid"])

        status = store.read_status()
        status["state"] = "healthy"
        status["supervisor_pid"] = 1
        store.write_status(status)

        reclaimed = service.ensure_runtime()

        assert reclaimed["state"] == "healthy"
        assert isinstance(reclaimed["supervisor_pid"], int)
        assert reclaimed["supervisor_pid"] > 1
        assert int(reclaimed["child_pid"]) != first_child_pid

        events = store.events_path.read_text(encoding="utf-8")
        assert "child_reclaim_started" in events
        assert "child_reclaim_succeeded" in events
    finally:
        supervisor.stop_child()
