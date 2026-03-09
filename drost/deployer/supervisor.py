from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from typing import IO, Any

from drost.deployer.state import DeployerStateStore


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()

class DeployerSupervisor:
    def __init__(self, store: DeployerStateStore, *, mirror_child_logs: bool = False) -> None:
        self._store = store
        self._mirror_child_logs = bool(mirror_child_logs)

    @staticmethod
    def _is_pid_alive(pid: int | None) -> bool:
        if pid is None or int(pid) <= 0:
            return False
        try:
            os.kill(int(pid), 0)
        except OSError:
            return False
        return True

    def _git_head(self) -> str:
        try:
            result = subprocess.run(
                ["git", "-C", str(self._store.config.repo_root), "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                check=True,
            )
        except Exception:
            return ""
        return str(result.stdout or "").strip()

    def _tee_stream(
        self,
        stream: IO[str] | None,
        *,
        file_path: str,
        console_stream: IO[str] | None,
    ) -> threading.Thread | None:
        if stream is None:
            return None

        def _forward() -> None:
            with open(file_path, "a", encoding="utf-8") as file_handle:
                while True:
                    chunk = stream.readline()
                    if chunk == "":
                        break
                    file_handle.write(chunk)
                    file_handle.flush()
                    if console_stream is not None:
                        console_stream.write(chunk)
                        console_stream.flush()

        thread = threading.Thread(target=_forward, daemon=True)
        thread.start()
        return thread

    def _spawn_process(self) -> tuple[subprocess.Popen[str], str]:
        command = shlex.split(self._store.config.start_command)
        stdout_path = self._store.logs_dir / "child.stdout.log"
        stderr_path = self._store.logs_dir / "child.stderr.log"
        env = dict(os.environ)
        env.setdefault("DROST_RUNTIME_LAUNCH_MODE", "deployer-child")
        env.setdefault("DROST_RUNTIME_START_COMMAND", "uv run drost")
        env.setdefault("DROST_REPO_ROOT", str(self._store.config.repo_root))
        env.setdefault("DROST_GATEWAY_HEALTH_URL", self._store.config.health_url)

        if self._mirror_child_logs:
            process = subprocess.Popen(
                command,
                cwd=self._store.config.repo_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                start_new_session=True,
                env=env,
            )
            self._tee_stream(process.stdout, file_path=str(stdout_path), console_stream=sys.stdout)
            self._tee_stream(process.stderr, file_path=str(stderr_path), console_stream=sys.stderr)
        else:
            with stdout_path.open("a", encoding="utf-8") as stdout_handle, stderr_path.open(
                "a", encoding="utf-8"
            ) as stderr_handle:
                process = subprocess.Popen(
                    command,
                    cwd=self._store.config.repo_root,
                    stdout=stdout_handle,
                    stderr=stderr_handle,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    start_new_session=True,
                    env=env,
                )
        return process, self._git_head()

    def _write_running_status(self, *, pid: int, active_commit: str) -> dict[str, Any]:
        next_status = self._store.read_status()
        next_status.update(
            {
                "mode": "subprocess",
                "state": "running",
                "repo_root": str(self._store.config.repo_root),
                "workspace_dir": str(self._store.config.workspace_dir),
                "state_dir": str(self._store.config.state_dir),
                "active_commit": active_commit,
                "child_pid": int(pid),
                "child_started_at": _utc_now(),
                "child_exited_at": "",
                "child_returncode": None,
                "last_error": "",
            }
        )
        return self._store.write_status(next_status)

    def refresh_status(self) -> dict[str, Any]:
        status = self._store.read_status()
        pid = status.get("child_pid")
        if isinstance(pid, int) and pid > 0 and not self._is_pid_alive(pid):
            status.update(
                {
                    "state": "idle",
                    "child_pid": None,
                    "child_exited_at": status.get("child_exited_at") or _utc_now(),
                }
            )
            self._store.write_status(status)
            self._store.append_event(
                "child_missing_from_status_refresh",
                child_pid=pid,
                child_returncode=status.get("child_returncode"),
            )
        return self._store.read_status()

    def start_child(self) -> dict[str, Any]:
        status = self.refresh_status()
        pid = status.get("child_pid")
        if isinstance(pid, int) and pid > 0 and self._is_pid_alive(pid):
            return status

        process, active_commit = self._spawn_process()
        self._write_running_status(pid=int(process.pid), active_commit=active_commit)
        self._store.append_event(
            "child_started",
            child_pid=int(process.pid),
            active_commit=active_commit,
            start_command=self._store.config.start_command,
        )
        return self._store.read_status()

    def _terminate_pid(self, pid: int, *, timeout_seconds: float = 5.0) -> int | None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return None
        except PermissionError:
            pass

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if not self._is_pid_alive(pid):
                return 0
            time.sleep(0.05)

        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            return 0
        except PermissionError:
            return None

        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if not self._is_pid_alive(pid):
                return -9
            time.sleep(0.05)
        return None

    def stop_child(self) -> dict[str, Any]:
        status = self.refresh_status()
        pid = status.get("child_pid")
        if not isinstance(pid, int) or pid <= 0:
            status.update({"state": "idle", "child_pid": None})
            self._store.write_status(status)
            return self._store.read_status()

        self._store.append_event("child_stopping", child_pid=pid)
        returncode = self._terminate_pid(pid)
        status = self._store.read_status()
        status.update(
            {
                "state": "idle",
                "child_pid": None,
                "child_exited_at": _utc_now(),
                "child_returncode": returncode,
            }
        )
        self._store.write_status(status)
        self._store.append_event(
            "child_stopped",
            child_pid=pid,
            child_returncode=returncode,
        )
        return self._store.read_status()

    def restart_child(self) -> dict[str, Any]:
        previous = self.refresh_status()
        self._store.append_event(
            "child_restarting",
            child_pid=previous.get("child_pid"),
        )
        self.stop_child()
        return self.start_child()

    def run_forever(self) -> int:
        existing = self.refresh_status()
        existing_pid = existing.get("child_pid")
        if isinstance(existing_pid, int) and existing_pid > 0 and self._is_pid_alive(existing_pid):
            self._store.append_event(
                "deployer_run_skipped_existing_child",
                child_pid=existing_pid,
            )
            return 0

        process, active_commit = self._spawn_process()
        self._write_running_status(pid=int(process.pid), active_commit=active_commit)
        self._store.append_event(
            "child_started",
            child_pid=int(process.pid),
            active_commit=active_commit,
            start_command=self._store.config.start_command,
            supervisor_mode="foreground",
        )

        stop_requested = False

        def _handle_signal(signum: int, _frame: Any) -> None:
            nonlocal stop_requested
            stop_requested = True
            self._store.append_event("deployer_signal_received", signal=signum, child_pid=int(process.pid))

        previous_sigint = signal.getsignal(signal.SIGINT)
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)
        try:
            while True:
                returncode = process.poll()
                if returncode is not None:
                    status = self._store.read_status()
                    status.update(
                        {
                            "state": "idle",
                            "child_pid": None,
                            "child_exited_at": _utc_now(),
                            "child_returncode": returncode,
                        }
                    )
                    self._store.write_status(status)
                    self._store.append_event(
                        "child_exited",
                        child_pid=int(process.pid),
                        child_returncode=int(returncode),
                    )
                    return returncode

                if stop_requested:
                    self.stop_child()
                    return 0

                time.sleep(0.1)
        finally:
            signal.signal(signal.SIGINT, previous_sigint)
            signal.signal(signal.SIGTERM, previous_sigterm)
