# Target Architecture

## Architectural Objective

Create a local control plane that can supervise the Drost runtime while remaining operational even when Drost itself is unhealthy.

## Core Components

### 1. Mutable Runtime: Drost

This is the normal agent process.

Responsibilities:

- serve FastAPI gateway
- handle Telegram traffic
- run the agent loop
- read and modify the repo when instructed
- request deploy/restart operations from the deployer

It is explicitly considered mutable and failure-prone.

### 2. External Control Plane: `drost-deployer`

This is a separate process.

Responsibilities:

- launch Drost
- restart Drost
- stop Drost
- validate health after restarts
- promote candidate commits
- roll back to known-good on failure
- track operational state externally
- serialize deploy requests

It must not require a healthy Drost process in order to operate.

### 3. Mutable Repo Checkout

This is the working tree that Drost edits.

Recommended default:

- repo root: `/Users/migel/drost`

This repo is where candidate changes live. It is not the source of truth for deployment state.

### 4. External State Directory

Deployer state must live outside the repo checkout.

Recommended default:

- `~/.drost/deployer/`

This directory should contain:

- `config.toml`
- `status.json`
- `known_good.json`
- `events.jsonl`
- `requests/`
- `locks/`
- optional pid and child metadata files

### 5. Health Validator

V1 validator:

- poll `GET /health`
- require success within a bounded startup window

Later validators can add richer checks, but `/health` is enough for first rollout.

## Recommended Packaging Model

### Decision

For v1, implement deployer code in the Drost repo but expose it as a separate executable:

- source lives in repo
- executable surface is `drost-deployer`
- runtime process is separate from `drost`

### Why This Is the Right Default

It balances three competing goals:

- fast implementation velocity
- explicit executable boundary
- ability to later move deployer runtime out of the mutable checkout

### Operational Recommendation

Development mode can run from the repo.

Real self-mod mode should run the deployer from a dedicated environment or installed executable path so that the deployer is less coupled to the mutable checkout it supervises.

## Process Model

Recommended v1 model:

1. `drost-deployer run` starts
2. deployer loads config/state
3. deployer launches Drost child process using configured start command
4. deployer monitors child exit and restart requests
5. deployer validates health after launches
6. deployer updates known-good state on successful promotion
7. deployer performs rollback if candidate boot fails

## Config Model

Recommended deployer config fields:

- `repo_root`
- `workspace_dir`
- `state_dir`
- `start_command`
- `health_url`
- `health_timeout_seconds`
- `health_poll_interval_seconds`
- `startup_grace_seconds`
- `rollback_on_failed_health`
- `known_good_ref_name`
- `request_poll_interval_seconds`
- `max_restart_attempts`
- `launch_mode`

Example launch modes:

- `subprocess`
- later: `tmux`, `launchd`

V1 should prefer a direct subprocess model. It is simpler and more testable.

## Known-Good Model

Known-good state should be tracked in two places:

### External canonical state

A JSON file in deployer state, for example:

- `~/.drost/deployer/known_good.json`

Contents:

- `ref`
- `commit`
- `promoted_at`
- `reason`
- `health_metadata`

### Git convenience ref

A git tag or branch-like ref for operator ergonomics, for example:

- `refs/tags/drost-known-good`

The external state file is the canonical deployer record. The git ref is an operator convenience.

## Candidate Model

The deployer should promote commits, not anonymous dirty working trees.

Recommended rule:

- before a deploy request is honored, the candidate must resolve to a commit id

If Drost has uncommitted changes, the system should first create a candidate commit or snapshot commit before deploy.

This makes rollback precise and reproducible.

## Request Channel

The deployer needs a narrow request interface.

Recommended v1 mechanism:

- file-backed request queue under `~/.drost/deployer/requests/`

Reasons:

- easy to debug
- resilient across process restarts
- no extra socket server required
- naturally auditable

Each request should be immutable JSON.

## Runtime Context Hardening

Drost should always know these facts without tool rediscovery:

- repo root
- workspace root
- deployer availability
- health URL
- start command or launch mode

These belong in runtime config and prompt context, not memory guesswork.

## Target End State

At the end of this project, the local system should look like this:

- Drost edits its own repo
- Drost requests a deploy through a narrow control surface
- deployer rolls forward to the candidate
- deployer checks health
- deployer promotes or rolls back
- Drost survives failed self-edits
