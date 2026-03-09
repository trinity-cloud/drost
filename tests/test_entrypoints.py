from __future__ import annotations

from pathlib import Path

from drost import main as launcher_main
from drost.deployer.config import DeployerConfig
from drost.deployer.state import DeployerStateStore


def test_drost_launcher_delegates_to_deployer_run(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def _fake_deployer_main(argv: list[str]) -> int:
        captured["argv"] = list(argv)
        return 7

    monkeypatch.setattr(launcher_main, "deployer_main", _fake_deployer_main)

    code = launcher_main.main(["--repo-root", "/tmp/repo", "--workspace-dir", "/tmp/work", "--json"])

    assert code == 7
    assert captured["argv"] == [
        "--repo-root",
        "/tmp/repo",
        "--workspace-dir",
        "/tmp/work",
        "run",
        "--json",
    ]


def test_deployer_config_normalizes_legacy_child_command_and_bootstrap_rewrites(tmp_path: Path) -> None:
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
                'start_command = "uv run drost"',
                "",
            ]
        ),
        encoding="utf-8",
    )

    config = DeployerConfig.load(
        repo_root=repo_root,
        workspace_dir=workspace_dir,
        state_dir=state_dir,
        config_path=config_path,
    )
    assert config.start_command == "uv run drost-gateway"

    store = DeployerStateStore(config)
    store.bootstrap()

    assert 'start_command = "uv run drost-gateway"' in config_path.read_text(encoding="utf-8")
