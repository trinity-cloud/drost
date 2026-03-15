from __future__ import annotations

import hashlib
import json
import shlex
import shutil
import subprocess
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from drost.config import Settings

WorkerKind = Literal["codex", "claude"]
WorkerMode = Literal["inspect", "implement", "review"]
WorkerStatus = Literal[
    "created",
    "launching",
    "running",
    "blocked",
    "stalled",
    "ready_for_review",
    "accepted",
    "rejected",
    "failed",
    "abandoned",
]

_ACTIVE_WRITE_STATUSES = {"launching", "running", "blocked", "stalled"}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _dump_time(value: datetime | None = None) -> str:
    actual = _utc_now() if value is None else value.astimezone(UTC)
    return actual.isoformat().replace("+00:00", "Z")


def _normalize_space(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def _normalize_list(values: list[Any] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in values or []:
        cleaned = _normalize_space(str(item or ""))
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        out.append(cleaned)
    return out


def _file_mtime(path: Path) -> str:
    try:
        return _dump_time(datetime.fromtimestamp(path.stat().st_mtime, tz=UTC))
    except Exception:
        return ""


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _tail_text(path: Path, *, lines: int = 20, max_chars: int = 4000) -> str:
    raw = _read_text(path)
    if not raw:
        return ""
    rows = raw.splitlines()
    tail = "\n".join(rows[-max(1, int(lines)) :]).strip()
    if len(tail) <= max_chars:
        return tail
    return tail[-max_chars:]


def _task_hash(prompt: str) -> str:
    return hashlib.sha256(str(prompt or "").encode("utf-8")).hexdigest()[:12]


def _binary_exists(command: str) -> bool:
    cleaned = str(command or "").strip()
    if not cleaned:
        return False
    candidate = Path(cleaned).expanduser()
    if candidate.exists():
        return True
    return shutil.which(cleaned) is not None


@dataclass(slots=True, frozen=True)
class WorkerReviewRecord:
    decision: str
    reviewer: str
    notes: str
    reviewed_at: str

    @classmethod
    def from_input(cls, value: WorkerReviewRecord | dict[str, Any]) -> WorkerReviewRecord:
        if isinstance(value, WorkerReviewRecord):
            return value
        raw = dict(value or {})
        return cls(
            decision=_normalize_space(raw.get("decision") or "").lower() or "accept",
            reviewer=_normalize_space(raw.get("reviewer") or "") or "operator",
            notes=str(raw.get("notes") or "").strip(),
            reviewed_at=_normalize_space(raw.get("reviewed_at") or "") or _dump_time(),
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True, frozen=True)
class WorkerJobRecord:
    job_id: str
    worker_kind: WorkerKind
    requested_mode: WorkerMode
    write_scope: str
    status: WorkerStatus
    requested_by: str
    repo_root: str
    binary_path: str
    session_name: str
    task_spec_path: str
    stdout_log_path: str
    stderr_log_path: str
    last_message_path: str
    exit_code_path: str
    review_path: str
    artifacts_path: str
    launch_command: str
    requested_outputs: list[str] = field(default_factory=list)
    requested_tests: list[str] = field(default_factory=list)
    blocked_reason: str = ""
    task_hash: str = ""
    exit_code: int | None = None
    started_at: str = ""
    completed_at: str = ""
    last_checked_at: str = ""
    last_visible_output_at: str = ""

    @classmethod
    def from_input(cls, value: WorkerJobRecord | dict[str, Any]) -> WorkerJobRecord:
        if isinstance(value, WorkerJobRecord):
            return value
        raw = dict(value or {})
        return cls(
            job_id=_normalize_space(raw.get("job_id") or ""),
            worker_kind=str(raw.get("worker_kind") or "codex").strip().lower() or "codex",
            requested_mode=str(raw.get("requested_mode") or "implement").strip().lower() or "implement",
            write_scope=_normalize_space(raw.get("write_scope") or "repo") or "repo",
            status=str(raw.get("status") or "created").strip().lower() or "created",
            requested_by=_normalize_space(raw.get("requested_by") or "") or "drost-agent",
            repo_root=str(raw.get("repo_root") or "").strip(),
            binary_path=str(raw.get("binary_path") or "").strip(),
            session_name=str(raw.get("session_name") or "").strip(),
            task_spec_path=str(raw.get("task_spec_path") or "").strip(),
            stdout_log_path=str(raw.get("stdout_log_path") or "").strip(),
            stderr_log_path=str(raw.get("stderr_log_path") or "").strip(),
            last_message_path=str(raw.get("last_message_path") or "").strip(),
            exit_code_path=str(raw.get("exit_code_path") or "").strip(),
            review_path=str(raw.get("review_path") or "").strip(),
            artifacts_path=str(raw.get("artifacts_path") or "").strip(),
            launch_command=str(raw.get("launch_command") or "").strip(),
            requested_outputs=_normalize_list(raw.get("requested_outputs")),
            requested_tests=_normalize_list(raw.get("requested_tests")),
            blocked_reason=str(raw.get("blocked_reason") or "").strip(),
            task_hash=str(raw.get("task_hash") or "").strip(),
            exit_code=(int(raw["exit_code"]) if raw.get("exit_code") is not None else None),
            started_at=str(raw.get("started_at") or "").strip(),
            completed_at=str(raw.get("completed_at") or "").strip(),
            last_checked_at=str(raw.get("last_checked_at") or "").strip(),
            last_visible_output_at=str(raw.get("last_visible_output_at") or "").strip(),
        )

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class WorkerSupervisor:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._root = settings.workspace_dir / "state" / "workers"
        self._jobs_dir = self._root / "jobs"
        self._jobs_dir.mkdir(parents=True, exist_ok=True)

    def _job_record_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.json"

    def _task_spec_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.prompt.md"

    def _stdout_log_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.stdout.jsonl"

    def _stderr_log_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.stderr.log"

    def _last_message_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.last_message.txt"

    def _exit_code_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.exit"

    def _review_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.review.json"

    def _artifacts_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.artifacts.json"

    def _read_json(self, path: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _load_job(self, job_id: str) -> WorkerJobRecord | None:
        payload = self._read_json(self._job_record_path(job_id))
        if payload is None:
            return None
        return WorkerJobRecord.from_input(payload)

    def _write_job(self, job: WorkerJobRecord) -> WorkerJobRecord:
        self._write_json(self._job_record_path(job.job_id), job.as_dict())
        return job

    def _load_review(self, job_id: str) -> WorkerReviewRecord | None:
        payload = self._read_json(self._review_path(job_id))
        if payload is None:
            return None
        return WorkerReviewRecord.from_input(payload)

    def _write_review(self, job_id: str, review: WorkerReviewRecord) -> WorkerReviewRecord:
        self._write_json(self._review_path(job_id), review.as_dict())
        return review

    def _job_ids(self) -> list[str]:
        out: list[str] = []
        for path in sorted(self._jobs_dir.glob("*.json")):
            name = path.name
            if name.endswith(".review.json") or name.endswith(".artifacts.json"):
                continue
            out.append(path.stem)
        return out

    @staticmethod
    def _make_job_id(worker_kind: WorkerKind) -> str:
        timestamp = _utc_now().strftime("%Y%m%dT%H%M%SZ")
        return f"w_{worker_kind}_{timestamp}_{uuid.uuid4().hex[:6]}"

    @staticmethod
    def _session_name(worker_kind: WorkerKind, job_id: str) -> str:
        return f"drost:{worker_kind}:{job_id}"

    def _binary_path(self, worker_kind: WorkerKind) -> str:
        if worker_kind == "codex":
            return str(self._settings.worker_codex_binary_path)
        return str(self._settings.worker_claude_binary_path)

    def _tmux_binary(self) -> str:
        return str(self._settings.worker_tmux_binary_path)

    def _repo_root(self, repo_root: str | None) -> Path:
        if repo_root:
            return Path(repo_root).expanduser().resolve()
        return self._settings.repo_root.resolve()

    def _build_codex_worker_command(self, job: WorkerJobRecord) -> str:
        return (
            f"cd {shlex.quote(job.repo_root)} && "
            f"cat {shlex.quote(job.task_spec_path)} | "
            f"{shlex.quote(job.binary_path)} exec "
            f"--cd {shlex.quote(job.repo_root)} "
            f"--dangerously-bypass-approvals-and-sandbox "
            f"--json "
            f"-o {shlex.quote(job.last_message_path)} "
            f"> {shlex.quote(job.stdout_log_path)} "
            f"2> {shlex.quote(job.stderr_log_path)}"
        )

    def _build_claude_worker_command(self, job: WorkerJobRecord) -> str:
        return (
            f"cd {shlex.quote(job.repo_root)} && "
            f"cat {shlex.quote(job.task_spec_path)} | "
            f"{shlex.quote(job.binary_path)} "
            f"--print "
            f"--output-format stream-json "
            f"--permission-mode bypassPermissions "
            f"--dangerously-skip-permissions "
            f"--add-dir {shlex.quote(job.repo_root)} "
            f"> {shlex.quote(job.stdout_log_path)} "
            f"2> {shlex.quote(job.stderr_log_path)}"
        )

    def _build_worker_shell_command(self, job: WorkerJobRecord) -> str:
        worker_command = (
            self._build_codex_worker_command(job)
            if job.worker_kind == "codex"
            else self._build_claude_worker_command(job)
        )
        return (
            f"{worker_command}; "
            f"code=$?; "
            f"printf '%s\\n' \"$code\" > {shlex.quote(job.exit_code_path)}"
        )

    def _build_tmux_launch_command(self, *, session_name: str, shell_command: str) -> tuple[list[str], str]:
        argv = [self._tmux_binary(), "new-session", "-d", "-s", session_name, shell_command]
        return argv, " ".join(shlex.quote(part) for part in argv)

    def _tmux_new_session(self, *, session_name: str, shell_command: str) -> tuple[bool, str]:
        argv, _launch = self._build_tmux_launch_command(session_name=session_name, shell_command=shell_command)
        try:
            result = subprocess.run(argv, capture_output=True, text=True, check=False)
        except Exception as exc:
            return False, str(exc)
        if result.returncode != 0:
            return False, _normalize_space(result.stderr or result.stdout or "tmux new-session failed")
        return True, ""

    def _tmux_has_session(self, session_name: str) -> bool:
        try:
            result = subprocess.run(
                [self._tmux_binary(), "has-session", "-t", session_name],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception:
            return False
        return result.returncode == 0

    def _tmux_kill_session(self, session_name: str) -> tuple[bool, str]:
        try:
            result = subprocess.run(
                [self._tmux_binary(), "kill-session", "-t", session_name],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:
            return False, str(exc)
        if result.returncode != 0:
            return False, _normalize_space(result.stderr or result.stdout or "tmux kill-session failed")
        return True, ""

    @staticmethod
    def _git_has_diff(repo_root: str) -> bool | None:
        try:
            result = subprocess.run(
                ["git", "-C", repo_root, "status", "--porcelain"],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception:
            return None
        if result.returncode != 0:
            return None
        return bool(str(result.stdout or "").strip())

    def _last_visible_output_at(self, job: WorkerJobRecord) -> str:
        timestamps = [
            _file_mtime(Path(job.stdout_log_path)),
            _file_mtime(Path(job.stderr_log_path)),
            _file_mtime(Path(job.last_message_path)),
        ]
        values = [value for value in timestamps if value]
        return max(values) if values else (job.last_visible_output_at or job.started_at)

    def _next_action(self, job: WorkerJobRecord, review: WorkerReviewRecord | None) -> str:
        if job.status in {"launching", "running"}:
            return "inspect"
        if job.status == "ready_for_review":
            return "review"
        if job.status == "accepted":
            return "request_deploy"
        if job.status == "rejected":
            return "retry"
        if job.status in {"blocked", "stalled", "failed"}:
            return "retry"
        if review is not None and review.decision == "accept":
            return "request_deploy"
        return "none"

    def _job_summary(self, job: WorkerJobRecord) -> dict[str, Any]:
        review = self._load_review(job.job_id)
        return {
            "job_id": job.job_id,
            "worker_kind": job.worker_kind,
            "requested_mode": job.requested_mode,
            "write_scope": job.write_scope,
            "repo_root": job.repo_root,
            "status": job.status,
            "session_name": job.session_name,
            "started_at": job.started_at,
            "completed_at": job.completed_at,
            "last_visible_output_at": job.last_visible_output_at,
            "blocked_reason": job.blocked_reason,
            "has_diff": self._git_has_diff(job.repo_root),
            "tests_requested": bool(job.requested_tests),
            "tests_passed": None,
            "awaiting_operator_decision": job.status == "ready_for_review",
            "next_recommended_action": self._next_action(job, review),
        }

    def _active_write_job_for_repo(self, repo_root: str) -> WorkerJobRecord | None:
        for row in self.list_jobs(refresh=True, detailed=False):
            if str(row.get("repo_root") or "") != repo_root:
                continue
            if str(row.get("write_scope") or "") == "none":
                continue
            if str(row.get("status") or "") not in _ACTIVE_WRITE_STATUSES:
                continue
            record = self._load_job(str(row.get("job_id") or ""))
            if record is not None:
                return record
        return None

    def launch_job(
        self,
        *,
        worker_kind: WorkerKind,
        prompt: str,
        repo_root: str | None = None,
        requested_mode: WorkerMode = "implement",
        write_scope: str = "repo",
        requested_outputs: list[str] | None = None,
        requested_tests: list[str] | None = None,
        requested_by: str = "drost-agent",
    ) -> dict[str, Any]:
        normalized_prompt = str(prompt or "").strip()
        if not normalized_prompt:
            raise ValueError("prompt is required")

        normalized_kind = str(worker_kind or "").strip().lower()
        if normalized_kind not in {"codex", "claude"}:
            raise ValueError(f"unsupported worker kind: {normalized_kind}")
        normalized_mode = str(requested_mode or "implement").strip().lower()
        if normalized_mode not in {"inspect", "implement", "review"}:
            raise ValueError(f"unsupported requested_mode: {normalized_mode}")

        resolved_repo_root = self._repo_root(repo_root)
        job_id = self._make_job_id(normalized_kind)  # type: ignore[arg-type]
        task_spec_path = self._task_spec_path(job_id)
        task_spec_path.write_text(normalized_prompt + "\n", encoding="utf-8")

        job = WorkerJobRecord(
            job_id=job_id,
            worker_kind=normalized_kind,  # type: ignore[arg-type]
            requested_mode=normalized_mode,  # type: ignore[arg-type]
            write_scope=_normalize_space(write_scope) or "repo",
            status="created",
            requested_by=_normalize_space(requested_by) or "drost-agent",
            repo_root=str(resolved_repo_root),
            binary_path=self._binary_path(normalized_kind),  # type: ignore[arg-type]
            session_name=self._session_name(normalized_kind, job_id),  # type: ignore[arg-type]
            task_spec_path=str(task_spec_path),
            stdout_log_path=str(self._stdout_log_path(job_id)),
            stderr_log_path=str(self._stderr_log_path(job_id)),
            last_message_path=str(self._last_message_path(job_id)),
            exit_code_path=str(self._exit_code_path(job_id)),
            review_path=str(self._review_path(job_id)),
            artifacts_path=str(self._artifacts_path(job_id)),
            launch_command="",
            requested_outputs=_normalize_list(requested_outputs),
            requested_tests=_normalize_list(requested_tests),
            blocked_reason="",
            task_hash=_task_hash(normalized_prompt),
        )
        worker_shell_command = self._build_worker_shell_command(job)
        _argv, launch_command = self._build_tmux_launch_command(
            session_name=job.session_name,
            shell_command=worker_shell_command,
        )
        job = WorkerJobRecord.from_input({**job.as_dict(), "launch_command": launch_command})
        self._write_json(
            Path(job.artifacts_path),
            {
                "requested_outputs": list(job.requested_outputs),
                "requested_tests": list(job.requested_tests),
                "tests_passed": None,
                "has_diff": None,
            },
        )

        if job.write_scope != "none":
            blocking_job = self._active_write_job_for_repo(job.repo_root)
            if blocking_job is not None:
                blocked = WorkerJobRecord.from_input(
                    {
                        **job.as_dict(),
                        "status": "blocked",
                        "blocked_reason": f"active write-capable job {blocking_job.job_id} already running for repo",
                        "last_checked_at": _dump_time(),
                    }
                )
                self._write_job(blocked)
                return self.get_job(blocked.job_id, refresh=False) or {"job": blocked.as_dict()}

        if not _binary_exists(self._tmux_binary()):
            blocked = WorkerJobRecord.from_input(
                {
                    **job.as_dict(),
                    "status": "blocked",
                    "blocked_reason": f"missing tmux binary: {self._tmux_binary()}",
                    "last_checked_at": _dump_time(),
                }
            )
            self._write_job(blocked)
            return self.get_job(blocked.job_id, refresh=False) or {"job": blocked.as_dict()}

        if not _binary_exists(job.binary_path):
            blocked = WorkerJobRecord.from_input(
                {
                    **job.as_dict(),
                    "status": "blocked",
                    "blocked_reason": f"missing worker binary: {job.binary_path}",
                    "last_checked_at": _dump_time(),
                }
            )
            self._write_job(blocked)
            return self.get_job(blocked.job_id, refresh=False) or {"job": blocked.as_dict()}

        launching = WorkerJobRecord.from_input(
            {
                **job.as_dict(),
                "status": "launching",
                "started_at": _dump_time(),
                "last_checked_at": _dump_time(),
            }
        )
        self._write_job(launching)
        ok, error = self._tmux_new_session(session_name=job.session_name, shell_command=worker_shell_command)
        if not ok:
            blocked = WorkerJobRecord.from_input(
                {
                    **launching.as_dict(),
                    "status": "blocked",
                    "blocked_reason": error,
                    "last_checked_at": _dump_time(),
                }
            )
            self._write_job(blocked)
            return self.get_job(blocked.job_id, refresh=False) or {"job": blocked.as_dict()}

        running = WorkerJobRecord.from_input(
            {
                **launching.as_dict(),
                "status": "running",
                "blocked_reason": "",
                "last_checked_at": _dump_time(),
                "last_visible_output_at": launching.started_at or _dump_time(),
            }
        )
        self._write_job(running)
        return self.get_job(running.job_id, refresh=False) or {"job": running.as_dict()}

    def refresh_job(self, job_id: str) -> dict[str, Any] | None:
        job = self._load_job(job_id)
        if job is None:
            return None
        exit_code: int | None = None
        exit_path = Path(job.exit_code_path)
        if exit_path.exists():
            try:
                exit_code = int(exit_path.read_text(encoding="utf-8").strip())
            except Exception:
                exit_code = None
        session_exists = self._tmux_has_session(job.session_name)
        updates: dict[str, Any] = {
            "last_checked_at": _dump_time(),
            "last_visible_output_at": self._last_visible_output_at(job),
        }
        if exit_code is not None:
            updates["exit_code"] = exit_code
            if job.status not in {"accepted", "rejected", "abandoned"}:
                updates["status"] = "ready_for_review" if exit_code == 0 else "failed"
            if not job.completed_at:
                updates["completed_at"] = _dump_time()
            if exit_code != 0 and not job.blocked_reason:
                updates["blocked_reason"] = f"worker_exit_code_{exit_code}"
        elif session_exists:
            if job.status in {"created", "launching", "running"}:
                updates["status"] = "running"
        elif job.status in {"launching", "running"}:
            updates["status"] = "stalled"
            updates["blocked_reason"] = job.blocked_reason or "session_missing_without_exit_code"

        refreshed = WorkerJobRecord.from_input({**job.as_dict(), **updates})
        self._write_job(refreshed)
        return self.get_job(job_id, refresh=False)

    def list_jobs(self, *, refresh: bool = True, detailed: bool = False) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for job_id in self._job_ids():
            payload = self.refresh_job(job_id) if refresh else self.get_job(job_id, refresh=False)
            if payload is None:
                continue
            rows.append(payload if detailed else dict(payload.get("summary") or {}))
        rows.sort(key=lambda item: str(item.get("started_at") or ""), reverse=True)
        return rows

    def status(self) -> dict[str, Any]:
        jobs = self.list_jobs(refresh=True, detailed=False)
        counts: dict[str, int] = {}
        active_by_repo: dict[str, str] = {}
        for job in jobs:
            status = str(job.get("status") or "")
            counts[status] = counts.get(status, 0) + 1
            if str(job.get("write_scope") or "") == "none":
                continue
            if status not in _ACTIVE_WRITE_STATUSES:
                continue
            repo_root = str(job.get("repo_root") or "")
            if repo_root and repo_root not in active_by_repo:
                active_by_repo[repo_root] = str(job.get("job_id") or "")
        return {
            "count": len(jobs),
            "counts": counts,
            "active_write_jobs_by_repo": active_by_repo,
            "jobs": jobs,
        }

    def get_job(self, job_id: str, *, refresh: bool = True) -> dict[str, Any] | None:
        record = self._load_job(job_id)
        if record is None:
            return None
        if refresh:
            refreshed = self.refresh_job(job_id)
            if refreshed is not None:
                return refreshed
            record = self._load_job(job_id)
            if record is None:
                return None
        review = self._load_review(job_id)
        artifacts = self._read_json(Path(record.artifacts_path)) or {}
        task_spec = _read_text(Path(record.task_spec_path))
        last_message = _read_text(Path(record.last_message_path)).strip()
        return {
            "job": record.as_dict(),
            "summary": self._job_summary(record),
            "review": None if review is None else review.as_dict(),
            "artifacts": artifacts,
            "task_spec": task_spec,
            "last_message": last_message,
            "stdout_tail": _tail_text(Path(record.stdout_log_path)),
            "stderr_tail": _tail_text(Path(record.stderr_log_path)),
            "session_exists": self._tmux_has_session(record.session_name),
        }

    def review_job(self, job_id: str, *, decision: str, reviewer: str = "", notes: str = "") -> dict[str, Any]:
        record = self._load_job(job_id)
        if record is None:
            raise KeyError(job_id)
        normalized_decision = _normalize_space(decision).lower()
        if normalized_decision not in {"accept", "reject"}:
            raise ValueError("decision must be accept or reject")
        review = self._write_review(
            job_id,
            WorkerReviewRecord.from_input(
                {
                    "decision": normalized_decision,
                    "reviewer": reviewer or "operator",
                    "notes": notes,
                    "reviewed_at": _dump_time(),
                }
            ),
        )
        updated = WorkerJobRecord.from_input(
            {
                **record.as_dict(),
                "status": "accepted" if review.decision == "accept" else "rejected",
                "completed_at": record.completed_at or _dump_time(),
                "last_checked_at": _dump_time(),
            }
        )
        self._write_job(updated)
        return self.get_job(job_id, refresh=False) or {"job": updated.as_dict()}

    def stop_job(self, job_id: str, *, reason: str = "") -> dict[str, Any]:
        record = self._load_job(job_id)
        if record is None:
            raise KeyError(job_id)
        if self._tmux_has_session(record.session_name):
            self._tmux_kill_session(record.session_name)
        exit_path = Path(record.exit_code_path)
        if not exit_path.exists():
            exit_path.write_text("130\n", encoding="utf-8")
        updated = WorkerJobRecord.from_input(
            {
                **record.as_dict(),
                "status": "abandoned",
                "exit_code": 130,
                "blocked_reason": _normalize_space(reason) or record.blocked_reason,
                "completed_at": record.completed_at or _dump_time(),
                "last_checked_at": _dump_time(),
            }
        )
        self._write_job(updated)
        return self.get_job(job_id, refresh=False) or {"job": updated.as_dict()}

    def retry_job(self, job_id: str, *, requested_by: str = "drost-agent", reason: str = "") -> dict[str, Any]:
        record = self._load_job(job_id)
        if record is None:
            raise KeyError(job_id)
        prompt = Path(record.task_spec_path).read_text(encoding="utf-8")
        if reason.strip():
            prompt = prompt.rstrip() + "\n\n[Retry Context]\n" + reason.strip() + "\n"
        return self.launch_job(
            worker_kind=record.worker_kind,
            prompt=prompt,
            repo_root=record.repo_root,
            requested_mode=record.requested_mode,
            write_scope=record.write_scope,
            requested_outputs=list(record.requested_outputs),
            requested_tests=list(record.requested_tests),
            requested_by=requested_by,
        )
