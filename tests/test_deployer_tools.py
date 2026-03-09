from __future__ import annotations

from pathlib import Path

from drost.config import Settings
from drost.deployer.config import DeployerConfig
from drost.deployer.state import DeployerStateStore
from drost.tools.deployer_request import DeployerRequestTool
from drost.tools.deployer_status import DeployerStatusTool


async def test_deployer_request_tool_queues_restart_request(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    settings = Settings(
        repo_root=repo_root,
        workspace_dir=workspace_dir,
    )

    tool = DeployerRequestTool(settings=settings)
    text = await tool.execute(action="restart", reason="reload runtime")

    assert "request_queued=true" in text
    assert "type=restart" in text
    assert "reason=reload runtime" in text

    config = DeployerConfig.load(repo_root=repo_root, workspace_dir=workspace_dir)
    store = DeployerStateStore(config)
    store.bootstrap()
    assert len(list(store.pending_requests_dir.glob("*.json"))) == 1


async def test_deployer_request_tool_requires_candidate_for_deploy(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    settings = Settings(
        repo_root=repo_root,
        workspace_dir=tmp_path / "workspace",
    )

    tool = DeployerRequestTool(settings=settings)
    text = await tool.execute(action="deploy")

    assert text == "Error: candidate_ref is required for deploy"


async def test_deployer_status_tool_reports_known_good_and_pending_requests(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workspace_dir = tmp_path / "workspace"
    settings = Settings(
        repo_root=repo_root,
        workspace_dir=workspace_dir,
    )

    config = DeployerConfig.load(repo_root=repo_root, workspace_dir=workspace_dir)
    store = DeployerStateStore(config)
    store.bootstrap()
    store.write_known_good(
        {
            "ref_name": "refs/drost/drost-known-good",
            "commit": "abc123",
            "promoted_at": "2026-03-09T00:00:00+00:00",
            "startup_duration_ms": 123,
            "health_url": "http://127.0.0.1:8766/health",
            "notes": "seed",
        }
    )

    request_tool = DeployerRequestTool(settings=settings)
    await request_tool.execute(action="restart", reason="status test")

    status_tool = DeployerStatusTool(settings=settings)
    text = await status_tool.execute()

    assert "known_good_commit=" in text
    assert "known_good_record:" in text
    assert "ref_name=refs/drost/drost-known-good" in text
    assert "request_counts=pending:1" in text
