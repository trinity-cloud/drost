from __future__ import annotations

import fcntl
import json
import os
import signal
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from drost.deployer.state import DeployerStateStore


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(slots=True)
class DeployerRunLock:
    store: DeployerStateStore
    _handle: IO[str] | None = None

    def acquire(self) -> bool:
        self.store.locks_dir.mkdir(parents=True, exist_ok=True)
        handle = self.store.run_lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return False

        handle.seek(0)
        handle.truncate()
        payload = {
            "pid": os.getpid(),
            "acquired_at": _utc_now(),
            "repo_root": str(self.store.config.repo_root),
            "state_dir": str(self.store.config.state_dir),
        }
        handle.write(json.dumps(payload, sort_keys=True) + "\n")
        handle.flush()
        self._handle = handle
        return True

    def release(self) -> None:
        if self._handle is None:
            return
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None

    def read_owner(self) -> dict[str, Any]:
        if not self.store.run_lock_path.exists():
            return {}
        try:
            payload = json.loads(self.store.run_lock_path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}


def _follow_file(path: Path, stream: IO[str], stop_event: threading.Event) -> threading.Thread:
    def _run() -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+", encoding="utf-8") as handle:
            handle.seek(0, os.SEEK_END)
            while not stop_event.is_set():
                line = handle.readline()
                if line:
                    stream.write(line)
                    stream.flush()
                    continue
                time.sleep(0.1)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return thread


def _emit_recent_lines(path: Path, stream: IO[str], *, max_lines: int = 20) -> None:
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in lines[-max(1, int(max_lines)) :]:
        stream.write(line + "\n")
    stream.flush()


def follow_existing_logs(store: DeployerStateStore, *, out: IO[str], err: IO[str]) -> int:
    owner = DeployerRunLock(store).read_owner()
    owner_pid = owner.get("pid")
    message = (
        f"deployer already running pid={owner_pid or 'unknown'}; "
        "attaching to existing child logs. Press Ctrl+C to detach.\n"
    )
    err.write(message)
    err.flush()

    _emit_recent_lines(store.logs_dir / "child.stdout.log", out)
    _emit_recent_lines(store.logs_dir / "child.stderr.log", err)

    stop_event = threading.Event()

    def _handle_signal(signum: int, _frame: Any) -> None:
        _ = signum
        stop_event.set()

    previous_sigint = signal.getsignal(signal.SIGINT)
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    try:
        stdout_thread = _follow_file(store.logs_dir / "child.stdout.log", out, stop_event)
        stderr_thread = _follow_file(store.logs_dir / "child.stderr.log", err, stop_event)
        while not stop_event.is_set():
            time.sleep(0.2)
        stdout_thread.join(timeout=1.0)
        stderr_thread.join(timeout=1.0)
        return 0
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)
