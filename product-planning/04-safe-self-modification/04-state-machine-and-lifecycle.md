# State Machine and Lifecycle

## Objective

Define deterministic lifecycle behavior for:

- initial boot
- restart
- candidate deploy
- health-gated promotion
- automatic rollback
- degraded/manual recovery

## Top-Level States

Recommended v1 states:

- `idle`
- `starting_child`
- `health_checking`
- `healthy`
- `processing_request`
- `rolling_back`
- `degraded`

Only one state should be active at a time.

## Initial Boot Lifecycle

### Flow

1. deployer starts
2. deployer loads config and state files
3. deployer resolves repo root and known-good record
4. deployer launches Drost child
5. deployer waits through startup grace period
6. deployer polls `/health`
7. if healthy, state becomes `healthy`
8. if unhealthy and known-good exists, deployer rolls back or restarts depending on configured context
9. if recovery fails, state becomes `degraded`

### Acceptance Rule

A boot is considered successful only when health check passes within the configured window.

## Restart Request Lifecycle

### Flow

1. request enters queue
2. deployer moves to `processing_request`
3. deployer stops child cleanly
4. deployer starts child again on current active ref
5. deployer performs health checks
6. if healthy, return to `healthy`
7. if unhealthy, decide whether to rollback or enter `degraded`

### Notes

A plain restart should not mutate known-good state unless explicitly configured.

## Candidate Deploy Lifecycle

### Flow

1. request enters queue with `candidate_ref`
2. deployer resolves candidate ref to exact commit hash
3. deployer records current active commit and current known-good commit
4. deployer moves repo checkout to candidate commit
5. deployer restarts child
6. deployer health-checks candidate
7. on success:
   - active commit becomes candidate
   - candidate is promoted to known-good
   - state returns to `healthy`
8. on failure:
   - deployer moves to `rolling_back`
   - repo is reset to known-good commit
   - child is restarted
   - known-good is revalidated
   - state returns to `healthy` if rollback succeeds, else `degraded`

## Rollback Lifecycle

### Flow

1. rollback request is received or health validation fails
2. deployer resolves rollback target
3. deployer stops child
4. deployer checks out target commit
5. deployer starts child
6. deployer validates health
7. if healthy, state returns to `healthy`
8. if unhealthy, state becomes `degraded`

## Degraded State

`degraded` means automatic safety mechanisms were not enough.

Triggers include:

- candidate fails and rollback target also fails
- repo cannot be checked out cleanly
- known-good reference is missing or invalid
- health checks never pass after bounded retries
- deployer cannot launch child process

Behavior in degraded state:

- no new deploy requests processed automatically
- status file reflects degraded condition
- event log records exact failure
- human intervention is expected

## Request Ordering

V1 should be strictly serialized.

Queue rules:

- one active request at a time
- restart/deploy/rollback requests are processed FIFO
- duplicate queued restart requests may be coalesced if desired
- deploy requests should not leapfrog rollback requests

## Idempotency Rules

The deployer should behave safely on repeated signals.

Examples:

- repeated restart request while already restarting should not fork multiple children
- repeated deploy request to the already-active commit should be a no-op or a logged no-op
- repeated rollback to the current known-good commit should not corrupt state

## Known-Good Promotion Rules

Promotion should happen only after health success.

V1 rule:

- if `/health` passes within the window, candidate is promotable

Later we may require stronger smoke checks, but v1 should keep promotion logic simple and deterministic.

## State Transition Table

### `idle -> starting_child`

Reason:

- deployer boot or manual start

### `starting_child -> health_checking`

Reason:

- child process launched

### `health_checking -> healthy`

Reason:

- health probe passed

### `health_checking -> rolling_back`

Reason:

- candidate failed validation and known-good exists

### `health_checking -> degraded`

Reason:

- no healthy candidate and no safe rollback path

### `healthy -> processing_request`

Reason:

- restart/deploy/rollback request dequeued

### `processing_request -> starting_child`

Reason:

- request requires child relaunch

### `processing_request -> healthy`

Reason:

- request is a no-op or status-only operation

### `rolling_back -> starting_child`

Reason:

- rollback target prepared and child relaunch starts

### `rolling_back -> degraded`

Reason:

- rollback target could not be prepared or child could not be started

## Manual Recovery Path

When the deployer cannot recover automatically, the operator should be able to:

1. inspect `status.json`
2. inspect `events.jsonl`
3. inspect current repo state and known-good state
4. force checkout to a good commit
5. rerun `drost-deployer run` or `drost-deployer rollback`

The state machine should make that recovery path obvious from on-disk artifacts.
