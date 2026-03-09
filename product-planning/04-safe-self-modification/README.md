# Safe Self-Modification

## Goal

Turn Drost from an agent that can edit its own code into an agent that can evolve safely.

The feature is bigger than a helper script. The real product is an external control plane that lets Drost:

- inspect and modify its own source tree
- request a supervised restart after a code change
- validate whether the new version booted cleanly
- promote the new version if healthy
- roll back automatically if the candidate is bad

This package treats that as a first-class subsystem: `drost-deployer`.

## Why This Package Exists

The latest live conversation surfaced a real product signal:

- Drost understands that its cwd is its own repo.
- Drost can already inspect process state, git state, tmux, gateway health endpoints, and source files.
- Drost correctly identified that self-modification without an external recovery path is unsafe.
- Drost proposed an external watchdog/deployer on its own.
- Drost then blocked on a packaging choice that should not have been a blocker.

That means the feature is ready to be designed and built deliberately.

## Core Design Position

The correct boundary is:

- Drost runtime is mutable.
- The deployer control plane is not allowed to depend on Drost being healthy.
- Promotion and rollback state must live outside the mutable repo checkout.
- Drost should become a client of the deployer, not its supervisor.

## Documents

- `01-current-state-and-product-signal.md`: what the latest conversation revealed and what the feature actually is
- `02-target-architecture.md`: runtime, deployer, state directory, repo, and process model
- `03-control-plane-contract.md`: CLI, request protocol, status files, event log, and Drost integration contract
- `04-state-machine-and-lifecycle.md`: exact deploy/restart/rollback lifecycle and transitions
- `05-safety-boundaries-and-failure-modes.md`: blast radius, failure analysis, and hard constraints
- `06-implementation-workplan.md`: phased build plan with code touchpoints and acceptance criteria
- `07-test-observability-and-rollout.md`: test strategy, instrumentation, and rollout path

## Source Basis

This package is grounded in:

- current Drost runtime code
- the live session transcript showing the deployer idea emerge
- current startup model (`uv run drost`, tmux, FastAPI `/health`)
- current agent loop behavior and tool surface

Primary current-state references:

- `drost/main.py`
- `drost/gateway.py`
- `drost/agent.py`
- `drost/channels/telegram.py`
- `drost/tools/shell_execute.py`
- `pyproject.toml`
- `README.md`
- `~/.drost/sessions/main_telegram_8271705169__s_2026-03-09_03-27-21.jsonl`
- `~/.drost/sessions/main_telegram_8271705169__s_2026-03-09_03-27-21.full.jsonl`

## Bottom Line

The right v1 is:

1. Build `drost-deployer` as a separate executable surface.
2. Keep its runtime state outside the mutable repo checkout.
3. Make candidate rollout commit-based, not loose-working-tree based.
4. Use health-gated promotion and automatic rollback.
5. Give Drost a narrow deployer request interface instead of leaving it to improvise with shell commands.

## Recommendation

Recommended v1 packaging model:

- implement deployer code in this repo
- expose it as a `pyproject.toml` entry point: `drost-deployer`
- run it as a separate long-lived process
- for real self-mod mode, install/run it from a dedicated environment or launcher path rather than treating it as part of the mutable Drost runtime

This gives fast iteration now without collapsing the control plane into the same mutable process that it exists to protect.
