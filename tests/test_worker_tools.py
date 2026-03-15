from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.tools.worker_request import WorkerRequestTool
from drost.tools.worker_status import WorkerStatusTool


def _settings(tmp_path: Path) -> Settings:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    return Settings(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
        worker_tmux_binary_path="tmux",
        worker_codex_binary_path="/opt/homebrew/bin/codex",
        worker_claude_binary_path="/Users/migel/.local/bin/claude",
    )


async def test_worker_request_tool_launches_job_and_worker_status_lists_it(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    request_tool = WorkerRequestTool(settings=settings)
    status_tool = WorkerStatusTool(settings=settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        request_tool._workers,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )
    monkeypatch.setattr(
        request_tool._workers,
        "_tmux_has_session",
        lambda session_name: True,
    )
    monkeypatch.setattr(
        status_tool._workers,
        "_tmux_has_session",
        lambda session_name: True,
    )

    launched = await request_tool.execute(
        action="launch",
        worker_kind="codex",
        prompt="Implement a bounded patch.",
        requested_tests=["uv run pytest -q tests/test_deployer.py"],
        requested_outputs=["git diff"],
    )
    assert "reporting_contract=verified_state_only" in launched
    assert "request_type=worker_launch" in launched
    assert "job_status=running" in launched
    assert "next_check=use_worker_status" in launched

    board = await status_tool.execute()
    assert "scope=board" in board
    assert "status=running" in board
    assert "worker_kind=codex" in board


async def test_worker_status_tool_returns_detail_view(tmp_path: Path, monkeypatch) -> None:
    settings = _settings(tmp_path)
    request_tool = WorkerRequestTool(settings=settings)
    status_tool = WorkerStatusTool(settings=settings)

    monkeypatch.setattr("drost.worker_supervision._binary_exists", lambda command: True)
    monkeypatch.setattr(
        request_tool._workers,
        "_tmux_new_session",
        lambda *, session_name, shell_command: (True, ""),
    )
    monkeypatch.setattr(
        request_tool._workers,
        "_tmux_has_session",
        lambda session_name: True,
    )

    launched = await request_tool.execute(
        action="launch",
        worker_kind="claude",
        prompt="Review the current patch.",
        requested_mode="review",
        write_scope="none",
    )
    job_id = next(
        line.split("=", 1)[1]
        for line in launched.splitlines()
        if line.startswith("job_id=")
    )

    job = status_tool._workers.get_job(job_id, refresh=False)
    assert job is not None
    Path(job["job"]["last_message_path"]).write_text("Patch reviewed.\n", encoding="utf-8")
    Path(job["job"]["stdout_log_path"]).write_text('{"type":"message","text":"done"}\n', encoding="utf-8")
    Path(job["job"]["stderr_log_path"]).write_text("warning: none\n", encoding="utf-8")

    monkeypatch.setattr(
        status_tool._workers,
        "_tmux_has_session",
        lambda session_name: True,
    )
    detail = await status_tool.execute(job_id=job_id, include_task_spec=True)

    assert "scope=job" in detail
    assert f"job_id={job_id}" in detail
    assert "last_message:" in detail
    assert "Patch reviewed." in detail
    assert "stdout_tail:" in detail
    assert '"type":"message"' in detail
    assert "stderr_tail:" in detail
    assert "task_spec:" in detail
