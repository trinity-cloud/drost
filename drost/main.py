from __future__ import annotations

import argparse
from collections.abc import Sequence

from drost.deployer.main import main as deployer_main


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="drost",
        description="Start Drost in supervised deployer mode by default.",
    )
    parser.add_argument("--repo-root", default=None, help="Repo root for the mutable Drost checkout.")
    parser.add_argument("--workspace-dir", default=None, help="Drost workspace root.")
    parser.add_argument("--state-dir", default=None, help="External deployer state directory.")
    parser.add_argument("--config-path", default=None, help="Path to deployer config TOML.")
    parser.add_argument("--json", action="store_true", help="Print final deployer status as JSON on exit.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    deployer_argv: list[str] = []
    if args.repo_root:
        deployer_argv.extend(["--repo-root", str(args.repo_root)])
    if args.workspace_dir:
        deployer_argv.extend(["--workspace-dir", str(args.workspace_dir)])
    if args.state_dir:
        deployer_argv.extend(["--state-dir", str(args.state_dir)])
    if args.config_path:
        deployer_argv.extend(["--config-path", str(args.config_path)])
    deployer_argv.append("run")
    if args.json:
        deployer_argv.append("--json")
    return deployer_main(deployer_argv)


if __name__ == "__main__":
    raise SystemExit(main())
