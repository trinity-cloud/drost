# Control Plane Contract

## Purpose

Define the smallest reliable interface between Drost and the deployer.

The contract should be:

- explicit
- observable
- replayable
- safe to audit from disk

## CLI Surface

Recommended v1 commands:

### `drost-deployer run`

Start the long-lived supervisor.

Responsibilities:

- load config
- restore last known state
- start or attach to child lifecycle management
- poll for requests
- manage health checks and rollback

### `drost-deployer status`

Print current deployer status.

Should show:

- deployer state
- child pid
- active commit
- known-good commit
- last health success time
- pending request count

### `drost-deployer request restart`

Queue a restart request.

Parameters:

- optional reason
- optional correlation id

### `drost-deployer request deploy --candidate-ref <ref>`

Queue a candidate deploy request.

Parameters:

- candidate ref or commit
- reason
- requested by
- optional metadata

### `drost-deployer rollback [--to-ref <ref>]`

Perform an explicit rollback.

Default target:

- known-good ref

### `drost-deployer promote --ref <ref>`

Optional operator command for manual known-good promotion.

This is optional for v1, but useful for recovery workflows.

## Request Queue

Recommended location:

- `~/.drost/deployer/requests/`

Recommended file naming:

- `<timestamp>_<request_id>.json`

Each request should be immutable once written.

## Request Schema

Recommended fields:

- `request_id`
- `type`
- `created_at`
- `requested_by`
- `reason`
- `candidate_ref`
- `candidate_commit`
- `metadata`

Valid request types for v1:

- `restart`
- `deploy_candidate`
- `rollback`

## Status File

Recommended location:

- `~/.drost/deployer/status.json`

Recommended fields:

- `mode`
- `state`
- `repo_root`
- `active_commit`
- `known_good_commit`
- `child_pid`
- `child_started_at`
- `last_health_ok_at`
- `last_request_id`
- `pending_request_ids`
- `last_error`

This file should be safe to read at any time.

## Event Log

Recommended location:

- `~/.drost/deployer/events.jsonl`

Every meaningful transition should append an event.

Recommended event types:

- `deployer_started`
- `child_started`
- `child_exited`
- `request_received`
- `deploy_started`
- `health_check_passed`
- `health_check_failed`
- `promotion_succeeded`
- `rollback_started`
- `rollback_succeeded`
- `rollback_failed`
- `manual_intervention_required`

## Known-Good Record

Recommended location:

- `~/.drost/deployer/known_good.json`

Recommended fields:

- `ref_name`
- `commit`
- `promoted_at`
- `startup_duration_ms`
- `health_url`
- `notes`

## Drost Integration Contract

Drost should not improvise deploy behavior with raw shell calls forever.

Recommended progression:

### V1

Drost may invoke the deployer via CLI, for example:

- `drost-deployer request deploy --candidate-ref HEAD --reason "self-edit"`

### V2

Expose an explicit Drost tool such as:

- `request_self_deploy`
- `request_restart`
- `deployer_status`

The tool should be a thin wrapper over the deployer contract.

## Repo Context Contract

Drost runtime config should surface:

- `DROST_REPO_ROOT`
- deployer state dir
- health URL
- current launch command

These should be available in the agent prompt and status tools.

This avoids path guessing and ad hoc environment discovery during deploy flows.

## Candidate Commit Contract

The deployer should accept a commit or ref, not vague working-tree state.

Recommended rule:

- deploy request resolves candidate to an exact commit hash before the rollout begins

If the candidate ref is not committed yet, the caller must create a snapshot commit first.

## Concurrency Contract

V1 should serialize deploy-affecting requests.

Rule:

- only one active deploy/restart/rollback request at a time

Later requests remain queued until the current one finishes.

## Human Operator Contract

The user must always be able to inspect and override the system manually.

Operator powers should include:

- reading status and event logs
- forcing rollback
- forcing promotion
- disabling deployer auto-restart if needed

The deployer should never hide state behind opaque internal memory.
