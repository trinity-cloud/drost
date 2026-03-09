# Test, Observability, and Rollout

## Test Objective

Prove that the deployer behaves correctly under realistic local failure modes.

The highest-risk failures are not unit-level syntax bugs. They are lifecycle bugs:

- child process management
- health timeout handling
- rollback correctness
- state persistence across failures

## Test Layers

### 1. Unit Tests

Cover:

- config parsing
- request parsing and ordering
- status file writing
- event log writing
- known-good state persistence
- state-machine transition rules

### 2. Integration Tests With Temporary Git Repos

Create temporary repos that simulate:

- healthy candidate commit
- broken candidate commit
- missing known-good
- dirty-tree snapshot flow

These tests should validate exact commit transitions and rollback behavior.

### 3. Integration Tests With Fake Child Apps

Use a small fake HTTP app that can simulate:

- fast healthy boot
- slow healthy boot
- never-healthy boot
- immediate crash
- health endpoint returning failure

This is the cleanest way to validate the deployer without constantly booting full Drost during test runs.

### 4. Manual End-to-End Test On Real Drost

Manual acceptance should verify:

1. deployer starts Drost successfully
2. Drost serves `/health`
3. a trivial code change can be deployed and promoted
4. a deliberately broken code change is rolled back automatically
5. operator can inspect status and events

## Required Observability

### Status File

Must answer at a glance:

- what commit is active
- what commit is known-good
- is the child healthy
- what request is in progress
- what failed last

### Event Log

Must record every important transition in append-only form.

This is essential for debugging self-mod incidents.

### Process Metadata

Should include:

- child pid
- launch time
- last health check time
- last successful health duration

## Suggested Event Payload Fields

For each event:

- `timestamp`
- `event_type`
- `request_id`
- `state_before`
- `state_after`
- `active_commit`
- `candidate_commit`
- `known_good_commit`
- `child_pid`
- `message`

## Rollout Stages

### Stage 0: Planning Only

- complete this package
- align on defaults

### Stage 1: Local Developer Prototype

- run deployer manually from repo
- supervise a local Drost process
- validate start/restart/health/rollback flow

### Stage 2: Real Self-Mod Mode

- run deployer from a dedicated install/runtime path
- let Drost request deploy actions through the deployer contract
- keep operator closely in the loop

### Stage 3: Default Workflow Adoption

- document deployer as the preferred way to run Drost when self-modification is enabled
- update README and operator docs

## Success Criteria

The rollout is successful when:

- broken self-edits do not strand the system in a dead state
- rollback is deterministic and auditable
- the user does not need to manually reconstruct what happened from vague logs
- Drost no longer blocks on fake packaging decisions when deployer is available

## Residual Risks

Even after v1 ships, these risks remain:

- `/health` can pass while deeper behavior is broken
- deployer runtime may still be too coupled to local assumptions
- users may bypass deployer and continue running plain `uv run drost`
- Drost may still make bad code changes, even if recovery is better

These are acceptable residual risks for v1.

## Recommended Next Step After Build

After v1 is working, the next upgrade should be a stronger validation probe.

Recommended phase-2 probe:

- `/health` pass
- plus one minimal functional smoke check against the gateway

That keeps the deployer simple while reducing false promotions.
