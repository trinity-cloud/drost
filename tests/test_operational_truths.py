from __future__ import annotations

import json
from pathlib import Path

from drost.config import Settings
from drost.operational_truths import OperationalTruthStore


def test_operational_truth_store_refresh_writes_tools_memory_and_snapshot(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "TOOLS.md").write_text("# TOOLS\n\nManual notes.\n", encoding="utf-8")
    (workspace / "MEMORY.md").write_text("# MEMORY\n\nHuman notes.\n", encoding="utf-8")

    settings = Settings(
        repo_root=repo_root,
        workspace_dir=workspace,
        runtime_launch_mode="deployer-default",
        runtime_start_command="uv run drost",
        gateway_health_url="http://127.0.0.1:8766/health",
        worker_tmux_binary_path="tmux",
        worker_codex_binary_path="/opt/homebrew/bin/codex",
        worker_claude_binary_path="/Users/migel/.local/bin/claude",
    )
    store = OperationalTruthStore(settings)

    snapshot = store.refresh()

    tools_content = (workspace / "TOOLS.md").read_text(encoding="utf-8")
    memory_content = (workspace / "MEMORY.md").read_text(encoding="utf-8")
    snapshot_payload = json.loads(store.snapshot_path.read_text(encoding="utf-8"))

    assert snapshot["runtime"]["repo_root"] == str(repo_root)
    assert snapshot_payload["runtime"]["start_command"] == "uv run drost"
    assert "Manual notes." in tools_content
    assert "## Machine-Managed Operational Truths" in tools_content
    assert "deploy requests must be verified against active_commit and health" in tools_content
    assert "worker_request and worker_status" in tools_content
    assert "Human notes." in memory_content
    assert "## Machine-Managed Operational Lessons" in memory_content
    assert "Promote is immediate and synchronous." in memory_content

