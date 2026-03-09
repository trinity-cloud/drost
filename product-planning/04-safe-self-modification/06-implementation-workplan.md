# Implementation Workplan

## Build Objective

Ship a usable local self-deployment control plane for Drost without bloating the runtime or over-automating too early.

## Phase 1: Runtime Context Hardening

### Build

- add explicit repo-root config to Drost
- surface repo-root, workspace-root, health URL, and launch model in prompt/runtime status
- stop forcing the model to rediscover its own topology with shell tools

### Code Touchpoints

- `drost/config.py`
- `drost/prompt_assembly.py`
- `drost/agent.py`
- `drost/tools/session_status.py`
- `README.md`

### Acceptance Criteria

- Drost knows repo root without calling `pwd` or `find`
- prompt/runtime status reflects deploy topology
- deploy-related reasoning does not depend on path guesswork

## Phase 2: Deployer Package Skeleton

### Build

- create deployer package/module in repo
- add CLI entry point `drost-deployer`
- implement config loading and state directory bootstrap
- implement status and event-log primitives

### Code Touchpoints

- `pyproject.toml`
- new package/module, for example `drost_deployer/` or `drost/deployer/`
- tests under a new deployer test module

### Acceptance Criteria

- `uv run drost-deployer --help` works
- deployer state directory is created deterministically
- config, status, and events are persisted outside the repo checkout

## Phase 3: Subprocess Supervision

### Build

- launch Drost as a child process from deployer
- track child pid and lifecycle
- add graceful stop/restart handling
- use direct subprocess launch as the first launch adapter

### Code Touchpoints

- new deployer runtime module
- possibly small process utilities module
- integration tests with fake child apps

### Acceptance Criteria

- deployer can start Drost
- deployer can stop Drost
- deployer can restart Drost without orphaning children
- child lifecycle is reflected in status and events

## Phase 4: Health-Gated Promotion and Rollback

### Build

- poll `/health` after launch
- track known-good commit externally
- implement candidate deploy flow
- implement automatic rollback to known-good on failed validation
- implement degraded/manual-intervention mode

### Code Touchpoints

- deployer state model
- deployer lifecycle/state machine module
- git helper module
- tests with passing and failing fake apps

### Acceptance Criteria

- healthy candidate gets promoted
- failed candidate rolls back automatically
- failed rollback enters degraded mode cleanly
- known-good state remains inspectable from disk

## Phase 5: Request Queue and Control Contract

### Build

- add file-backed request queue
- support `restart`, `deploy_candidate`, and `rollback`
- implement request serialization and idempotent handling
- add CLI helpers to enqueue requests

### Code Touchpoints

- deployer request/state modules
- CLI command handlers
- tests for queued requests and ordering

### Acceptance Criteria

- requests survive deployer restart
- only one deploy-affecting request is processed at a time
- duplicate/no-op requests are handled safely

## Phase 6: Drost Integration

### Build

- add a narrow Drost-side interface to request deployer actions
- first pass may be a dedicated tool or a focused runtime wrapper around the CLI
- stop relying on raw ad hoc shell commands for deployment actions

### Code Touchpoints

- `drost/tools/`
- `drost/agent.py`
- `drost/prompt_assembly.py`
- `README.md`

### Acceptance Criteria

- Drost can request restart/deploy through an explicit contract
- Drost no longer needs to invent deploy flows in free-form shell commands
- deployment requests are visible in deployer state/events

## Phase 7: Operator Ergonomics and Rollout

### Build

- add operator-facing `status` and `rollback` commands
- document normal install/run flow
- add sample `config.toml`
- define local rollout instructions

### Code Touchpoints

- deployer CLI
- docs
- example config/assets

### Acceptance Criteria

- a human can install and run the deployer without reading code
- a human can inspect status and roll back manually
- normal local workflow is documented end to end

## Recommended Sequence

Recommended build order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 7
7. Phase 6

## Why This Order

- repo-root/runtime context hardening removes immediate ambiguity in agent reasoning
- deployer package and supervision must exist before Drost integration can target them
- health-gated promotion/rollback is the core value, so it lands before convenience surfaces
- Drost-side integration should come after the deployer contract is stable

## Default Decisions For V1

These choices should not be reopened unless they fail in implementation:

- use a separate CLI entry point: `drost-deployer`
- use external state under `~/.drost/deployer/`
- use subprocess launch adapter first
- use file-backed request queue first
- use `/health` as the first validation probe
- use commit-based candidate deploys

## Suggested Config Keys

Recommended additions:

- `DROST_REPO_ROOT`
- deployer config file keys for:
  - `repo_root`
  - `state_dir`
  - `start_command`
  - `health_url`
  - `startup_grace_seconds`
  - `health_timeout_seconds`
  - `request_poll_interval_seconds`
  - `known_good_ref_name`

## Deliverable Definition

V1 is complete when:

- Drost can modify code and request a supervised restart
- deployer can validate the new candidate with `/health`
- deployer promotes healthy candidates and rolls back failed ones
- state is inspectable from disk
- the operator can recover manually when automation fails
