# Deployer Semantics And Rollout Correctness

## Problem

The conversation exposed both semantic confusion and a real control-plane bug.

### Semantic confusion seen in practice

- assuming `promote` is queued when it is immediate
- reporting a deploy as queued or active without verifying deployer state
- treating request intent as equivalent to runtime state

### Correctness bug found in code

In `drost/deployer/rollout.py`, `deploy_candidate()` currently uses repo worktree HEAD to decide whether deployment is a no-op.

That allows this broken state:

- repo HEAD already equals candidate commit
- active child runtime is still serving an older commit
- deployer emits `deploy_candidate_noop`
- runtime never rolls forward

## Principle

The deployer must reason about the runtime, not just the repository.

Repo state and active runtime state are related but not interchangeable.

## Target Semantics

### Promote

`promote` should mean:

- validate the currently active runtime
- if validation passes, mark its active commit as known-good
- immediate action, not queued

### Deploy Candidate

`deploy candidate X` should mean:

- if `X == active runtime commit`, no-op
- else perform candidate rollout to `X`
- checkout if needed
- restart child if needed
- validate runtime
- update `active_commit`
- optionally promote to known-good when policy says so

### Rollback

`rollback` should mean:

- move active runtime back to target ref/commit
- validate
- surface degraded mode if rollback validation fails

## Required Fixes

### 1. No-Op Condition

Change no-op logic from:
- `candidate_commit == repo HEAD`

to:
- `candidate_commit == status.active_commit`

or equivalent runtime-grounded state.

### 2. Reporting States

Drost should report deploy progress only using explicit control-plane states:

- `requested`
- `accepted`
- `active`
- `healthy/live`
- `promoted`
- `failed`
- `rolled_back`
- `noop`

### 3. Event Model

Deployer events should cleanly capture:

- request accepted
- request activated
- candidate checkout started
- child restart started
- validation started
- validation passed/failed
- active commit changed
- noop decision and why

### 4. Status Payload

Status should distinguish:

- `repo_head_commit`
- `active_commit`
- `known_good_commit`
- `requested_candidate_commit`
- `last_noop_reason`

Right now these concepts are too easy to conflate.

## Acceptance Criteria

- deploy of a candidate commit cannot noop solely because repo HEAD already moved
- promote/report semantics are explicit and teachable
- operator endpoints and agent-facing tools expose enough state to prevent misreporting
