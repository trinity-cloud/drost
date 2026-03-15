from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.worker_supervision import WorkerSupervisor


def _settings(tmp_path: Path) -> Settings:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    return Settings(
        repo_root=repo_root,
        workspace_dir=workspace_dir,
        worker_tmux_binary_path="tmux",
        worker_codex_binary_path="/opt/homebrew/bin/codex",
        worker_claude_binary_path="/Users/migel/.local/bin/claude",
    )


def test_worker_supervision_launch_builds_codex_job_files_and_command(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    supervisor = WorkerSupervisor(settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        supervisor,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )

    payload = supervisor.launch_job(
        worker_kind="codex",
        prompt="Implement a bounded patch.",
        requested_tests=["uv run pytest -q tests/test_deployer.py"],
        requested_outputs=["git diff"],
        requested_by="test",
    )

    job = payload["job"]
    assert job["worker_kind"] == "codex"
    assert job["status"] == "running"
    assert job["session_name"].startswith("drost:codex:w_codex_")
    assert "codex exec" in job["launch_command"]
    assert "--json" in job["launch_command"]
    assert "-o" in job["launch_command"]
    assert Path(job["task_spec_path"]).exists()
    assert Path(job["artifacts_path"]).exists()
    assert payload["summary"]["next_recommended_action"] in {"inspect", "review"}


def test_worker_supervision_launch_builds_claude_command(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    supervisor = WorkerSupervisor(settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        supervisor,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )
    monkeypatch.setattr(
        supervisor,
        "_tmux_has_session",
        lambda session_name: True,
    )

    payload = supervisor.launch_job(
        worker_kind="claude",
        prompt="Review the current repo and propose a patch.",
        requested_mode="review",
        write_scope="none",
    )

    launch_command = payload["job"]["launch_command"]
    assert payload["job"]["worker_kind"] == "claude"
    assert "--print" in launch_command
    assert "--output-format stream-json" in launch_command
    assert "--permission-mode bypassPermissions" in launch_command
    assert "--dangerously-skip-permissions" in launch_command


def test_worker_supervision_blocks_second_write_job_for_same_repo(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    supervisor = WorkerSupervisor(settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        supervisor,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )
    monkeypatch.setattr(
        supervisor,
        "_tmux_has_session",
        lambda session_name: True,
    )

    first = supervisor.launch_job(worker_kind="codex", prompt="First patch.")
    second = supervisor.launch_job(worker_kind="claude", prompt="Second patch.")

    assert first["job"]["status"] == "running"
    assert second["job"]["status"] == "blocked"
    assert first["job"]["job_id"] in second["job"]["blocked_reason"]

    status = supervisor.status()
    assert status["counts"]["running"] == 1
    assert status["counts"]["blocked"] == 1
    assert status["active_write_jobs_by_repo"][str(settings.repo_root)] == first["job"]["job_id"]


def test_worker_supervision_refresh_review_stop_and_retry(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    supervisor = WorkerSupervisor(settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        supervisor,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )

    session_state = {"exists": False}
    monkeypatch.setattr(
        supervisor,
        "_tmux_has_session",
        lambda session_name: bool(session_state["exists"]),
    )
    monkeypatch.setattr(
        supervisor,
        "_tmux_kill_session",
        lambda session_name: (True, ""),
    )

    launched = supervisor.launch_job(worker_kind="codex", prompt="Patch repo carefully.")
    job = launched["job"]
    Path(job["stdout_log_path"]).write_text('{"type":"delta","text":"working"}\n', encoding="utf-8")
    Path(job["stderr_log_path"]).write_text("warning: something minor\n", encoding="utf-8")
    Path(job["last_message_path"]).write_text("Patch complete.\n", encoding="utf-8")
    Path(job["exit_code_path"]).write_text("0\n", encoding="utf-8")

    refreshed = supervisor.refresh_job(job["job_id"])
    assert refreshed is not None
    assert refreshed["job"]["status"] == "ready_for_review"
    assert refreshed["last_message"] == "Patch complete."
    assert '"type":"delta"' in refreshed["stdout_tail"]
    assert "warning: something minor" in refreshed["stderr_tail"]

    reviewed = supervisor.review_job(job["job_id"], decision="accept", reviewer="test", notes="Looks good.")
    assert reviewed["job"]["status"] == "accepted"
    assert reviewed["review"]["decision"] == "accept"

    stopped = supervisor.stop_job(job["job_id"], reason="finished")
    assert stopped["job"]["status"] == "abandoned"
    assert stopped["job"]["exit_code"] == 130

    retry = supervisor.retry_job(job["job_id"], requested_by="retry-test", reason="try again")
    assert retry["job"]["status"] == "running"
    assert retry["job"]["job_id"] != job["job_id"]
