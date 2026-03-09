from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence

from drost.deployer.config import DeployerConfig
from drost.deployer.request_queue import DeployerRequestQueue
from drost.deployer.rollout import DeployerRolloutManager
from drost.deployer.service import DeployerService
from drost.deployer.state import DeployerStateStore
from drost.deployer.supervisor import DeployerSupervisor


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

    config_parser = subparsers.add_parser("config", help="Print resolved deployer config.")
    config_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    events_parser = subparsers.add_parser("events", help="Print deployer events.")
    events_parser.add_argument("--limit", type=int, default=20, help="Number of most recent events to print.")
    events_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    requests_parser = subparsers.add_parser("requests", help="Print queued deployer requests.")
    requests_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    start_parser = subparsers.add_parser("start", help="Start Drost as a supervised child process.")
    start_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    stop_parser = subparsers.add_parser("stop", help="Stop the current supervised Drost child process.")
    stop_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    restart_parser = subparsers.add_parser("restart", help="Restart the current supervised Drost child process.")
    restart_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    health_parser = subparsers.add_parser("healthcheck", help="Probe the configured Drost health endpoint.")
    health_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    promote_parser = subparsers.add_parser("promote", help="Mark the current healthy runtime as known-good.")
    promote_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    deploy_parser = subparsers.add_parser(
        "deploy",
        help="Checkout a candidate commit/ref, restart Drost, validate /health, and rollback on failure.",
    )
    deploy_parser.add_argument("candidate_ref", help="Candidate git ref or commit to deploy.")
    deploy_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    rollback_parser = subparsers.add_parser("rollback", help="Rollback Drost to the known-good commit.")
    rollback_parser.add_argument("--to-ref", default=None, help="Optional rollback target ref or commit.")
    rollback_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    request_parser = subparsers.add_parser("request", help="Queue a deployer request for the long-lived service.")
    request_subparsers = request_parser.add_subparsers(dest="request_command", required=True)

    request_restart_parser = request_subparsers.add_parser("restart", help="Queue a restart request.")
    request_restart_parser.add_argument("--requested-by", default="", help="Operator or subsystem queuing the request.")
    request_restart_parser.add_argument("--reason", default="", help="Why the restart is being requested.")
    request_restart_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    request_deploy_parser = request_subparsers.add_parser("deploy", help="Queue a candidate deploy request.")
    request_deploy_parser.add_argument("candidate_ref", help="Candidate git ref or commit to deploy.")
    request_deploy_parser.add_argument("--requested-by", default="", help="Operator or subsystem queuing the request.")
    request_deploy_parser.add_argument("--reason", default="", help="Why the deploy is being requested.")
    request_deploy_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    request_rollback_parser = request_subparsers.add_parser("rollback", help="Queue a rollback request.")
    request_rollback_parser.add_argument("--to-ref", default="", help="Optional rollback target ref or commit.")
    request_rollback_parser.add_argument("--requested-by", default="", help="Operator or subsystem queuing the request.")
    request_rollback_parser.add_argument("--reason", default="", help="Why the rollback is being requested.")
    request_rollback_parser.add_argument("--json", action="store_true", help="Print raw JSON.")

    run_parser = subparsers.add_parser("run", help="Run the deployer in foreground supervision mode.")
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
        f"active_request_id={status.get('active_request_id') or ''}",
        f"active_request_type={status.get('active_request_type') or ''}",
        f"pending_request_ids={status.get('pending_request_ids') or []}",
        f"child_pid={status.get('child_pid')}",
        f"child_started_at={status.get('child_started_at') or ''}",
        f"child_exited_at={status.get('child_exited_at') or ''}",
        f"child_returncode={status.get('child_returncode')}",
        f"last_health_checked_at={status.get('last_health_checked_at') or ''}",
        f"last_health_status_code={status.get('last_health_status_code')}",
        f"last_health_body={status.get('last_health_body') or ''}",
        f"last_health_ok_at={status.get('last_health_ok_at') or ''}",
        f"last_error={status.get('last_error') or ''}",
        f"updated_at={status.get('updated_at') or ''}",
    ]
    return "\n".join(lines)


def _print_status(status: dict[str, object], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(status, indent=2, sort_keys=True))
    else:
        print(_render_status_text(status))


def _render_config_text(config: DeployerConfig) -> str:
    lines = [
        f"repo_root={config.repo_root}",
        f"workspace_dir={config.workspace_dir}",
        f"state_dir={config.state_dir}",
        f"config_path={config.config_path}",
        f"start_command={config.start_command}",
        f"health_url={config.health_url}",
        f"startup_grace_seconds={config.startup_grace_seconds}",
        f"health_timeout_seconds={config.health_timeout_seconds}",
        f"request_poll_interval_seconds={config.request_poll_interval_seconds}",
        f"known_good_ref_name={config.known_good_ref_name}",
    ]
    return "\n".join(lines)


def _tail_events(events_path: str, *, limit: int) -> list[dict[str, object]]:
    from pathlib import Path

    path = Path(events_path)
    if not path.exists():
        return []
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [json.loads(line) for line in lines[-max(1, int(limit)) :]]


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    config, store = _load_state(args)
    supervisor = DeployerSupervisor(store)
    queue = DeployerRequestQueue(store)
    rollout = DeployerRolloutManager(store=store, supervisor=supervisor)
    service = DeployerService(store=store, supervisor=supervisor, rollout=rollout, queue=queue)

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
        status = supervisor.refresh_status()
        _print_status(status, as_json=bool(args.json))
        return 0

    if args.command == "config":
        if args.json:
            print(
                json.dumps(
                    {
                        "repo_root": str(config.repo_root),
                        "workspace_dir": str(config.workspace_dir),
                        "state_dir": str(config.state_dir),
                        "config_path": str(config.config_path),
                        "start_command": config.start_command,
                        "health_url": config.health_url,
                        "startup_grace_seconds": config.startup_grace_seconds,
                        "health_timeout_seconds": config.health_timeout_seconds,
                        "request_poll_interval_seconds": config.request_poll_interval_seconds,
                        "known_good_ref_name": config.known_good_ref_name,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
        else:
            print(_render_config_text(config))
        return 0

    if args.command == "events":
        payload = _tail_events(str(store.events_path), limit=int(args.limit))
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            for row in payload:
                print(json.dumps(row, sort_keys=True))
        return 0

    if args.command == "requests":
        payload = queue.list_requests()
        if args.json:
            print(json.dumps(payload, indent=2, sort_keys=True))
        else:
            print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    try:
        if args.command == "start":
            status = supervisor.start_child()
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "stop":
            status = supervisor.stop_child()
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "restart":
            status = supervisor.restart_child()
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "healthcheck":
            status = rollout.healthcheck(startup_grace_seconds=0.0)
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "promote":
            status = rollout.promote_current()
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "deploy":
            status = rollout.deploy_candidate(args.candidate_ref)
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "rollback":
            status = rollout.rollback(to_ref=args.to_ref)
            _print_status(status, as_json=bool(args.json))
            return 0

        if args.command == "request":
            if args.request_command == "restart":
                request = queue.enqueue(
                    "restart",
                    requested_by=args.requested_by,
                    reason=args.reason,
                )
            elif args.request_command == "deploy":
                request = queue.enqueue(
                    "deploy_candidate",
                    requested_by=args.requested_by,
                    reason=args.reason,
                    candidate_ref=args.candidate_ref,
                )
            elif args.request_command == "rollback":
                request = queue.enqueue(
                    "rollback",
                    requested_by=args.requested_by,
                    reason=args.reason,
                    rollback_ref=args.to_ref,
                )
            else:
                raise ValueError(f"unknown request command: {args.request_command}")
            payload = request.as_dict()
            payload["pending_request_ids"] = queue.pending_request_ids()
            if getattr(args, "json", False):
                print(json.dumps(payload, indent=2, sort_keys=True))
            else:
                print(json.dumps(payload, indent=2, sort_keys=True))
            return 0

        if args.command == "run":
            store.append_event(
                "deployer_started",
                repo_root=str(store.config.repo_root),
                state_dir=str(store.config.state_dir),
                start_command=store.config.start_command,
                health_url=store.config.health_url,
            )
            exit_code = service.run_forever()
            current = supervisor.refresh_status()
            _print_status(current, as_json=bool(args.json))
            return exit_code
    except Exception as exc:
        status = store.read_status()
        status["last_error"] = str(exc)
        store.write_status(status)
        store.append_event(
            "deployer_command_failed",
            command=args.command,
            error=str(exc),
        )
        if getattr(args, "json", False):
            _print_status(store.read_status(), as_json=True)
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
