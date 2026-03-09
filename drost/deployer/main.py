from __future__ import annotations

import argparse
import json
from collections.abc import Sequence

from drost.deployer.config import DeployerConfig
from drost.deployer.state import DeployerStateStore


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="drost-deployer",
        description="External control-plane skeleton for supervised Drost deployment and rollback.",
    )
    parser.add_argument("--repo-root", default=None, help="Repo root for the mutable Drost checkout.")
    parser.add_argument("--workspace-dir", default=None, help="Drost workspace root.")
    parser.add_argument("--state-dir", default=None, help="External deployer state directory.")
    parser.add_argument("--config-path", default=None, help="Path to deployer config TOML.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init", help="Bootstrap deployer state files and directories.")

    status_parser = subparsers.add_parser("status", help="Print deployer status.")
    status_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    run_parser = subparsers.add_parser("run", help="Bootstrap deployer state and mark the skeleton as started.")
    run_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    return parser


def _load_state(args: argparse.Namespace) -> tuple[DeployerConfig, DeployerStateStore]:
    config = DeployerConfig.load(
        repo_root=args.repo_root,
        workspace_dir=args.workspace_dir,
        state_dir=args.state_dir,
        config_path=args.config_path,
    )
    store = DeployerStateStore(config)
    store.bootstrap()
    return config, store


def _render_status_text(status: dict[str, object]) -> str:
    lines = [
        f"mode={status.get('mode') or ''}",
        f"state={status.get('state') or ''}",
        f"repo_root={status.get('repo_root') or ''}",
        f"workspace_dir={status.get('workspace_dir') or ''}",
        f"state_dir={status.get('state_dir') or ''}",
        f"active_commit={status.get('active_commit') or ''}",
        f"known_good_commit={status.get('known_good_commit') or ''}",
        f"child_pid={status.get('child_pid')}",
        f"last_health_ok_at={status.get('last_health_ok_at') or ''}",
        f"last_error={status.get('last_error') or ''}",
        f"updated_at={status.get('updated_at') or ''}",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    _, store = _load_state(args)

    if args.command == "init":
        store.append_event(
            "deployer_initialized",
            repo_root=str(store.config.repo_root),
            state_dir=str(store.config.state_dir),
        )
        status = store.read_status()
        print(_render_status_text(status))
        return 0

    if args.command == "status":
        status = store.read_status()
        if args.json:
            print(json.dumps(status, indent=2, sort_keys=True))
        else:
            print(_render_status_text(status))
        return 0

    if args.command == "run":
        status = store.read_status()
        status.update(
            {
                "mode": "skeleton",
                "state": "idle",
                "repo_root": str(store.config.repo_root),
                "workspace_dir": str(store.config.workspace_dir),
                "state_dir": str(store.config.state_dir),
            }
        )
        store.write_status(status)
        store.append_event(
            "deployer_started",
            repo_root=str(store.config.repo_root),
            state_dir=str(store.config.state_dir),
            start_command=store.config.start_command,
            health_url=store.config.health_url,
            note="Phase 2 skeleton only. Supervision lands in Phase 3.",
        )
        current = store.read_status()
        if args.json:
            print(json.dumps(current, indent=2, sort_keys=True))
        else:
            print(_render_status_text(current))
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
