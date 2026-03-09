# Safety Boundaries and Failure Modes

## Safety Objective

Make self-modification survivable without pretending it is risk-free.

The system does not need to eliminate all risk. It needs to make bad candidates recoverable.

## Hard Boundary

The deployer must sit outside the Drost runtime blast radius.

This means:

- Drost process can die and deployer still runs
- repo checkout can be broken and deployer still knows the previous known-good commit
- deployer state is stored outside the mutable repo
- rollback decision does not depend on Drost memory or agent reasoning

## What Must Stay External

These artifacts cannot be owned only by the Drost process:

- known-good state
- deploy request queue
- deployer status
- deployer event log
- child lifecycle supervision

## What Can Stay Mutable

These are allowed to be edited by Drost:

- application code in repo
- tests in repo
- docs in repo
- workspace files
- candidate commits prior to deployment

The point is not to prevent self-editing. The point is to protect recovery.

## Major Failure Modes

### 1. Candidate boots but is logically broken

Symptom:

- `/health` returns 200 but important behavior is broken

Mitigation:

- v1 accepts this limitation
- event log should record that validation was only `/health`
- later add stronger smoke probes

### 2. Candidate never boots

Symptom:

- process exits immediately
- health check never passes

Mitigation:

- bounded retries
- rollback to known-good
- degraded state if rollback also fails

### 3. Known-good ref is missing or invalid

Symptom:

- deployer cannot determine rollback target

Mitigation:

- maintain both external known-good record and git convenience ref
- validate known-good target during deployer startup
- block candidate deploys until known-good is valid

### 4. Dirty worktree makes rollback ambiguous

Symptom:

- changes are not captured in a commit
- rollback target does not match current state

Mitigation:

- require candidate deploys to resolve to exact commits
- auto-snapshot before candidate rollout if needed

### 5. Drost edits deployer source in the same repo

Symptom:

- control-plane code and app code mutate together

Mitigation:

- recommended real self-mod mode runs deployer from a separate installed environment or launcher path
- deployer runtime should not depend on a healthy Drost child

### 6. Deployer itself crashes

Symptom:

- child may still be running, but supervision is gone

Mitigation:

- keep external state durable
- make deployer restartable without losing knowledge of active and known-good commits
- later operator can place deployer itself under launchd/system supervisor if desired

### 7. Drost guesses wrong repo root

Symptom:

- tool calls target nonexistent paths
- deployer operations point at wrong checkout

Mitigation:

- explicit `repo_root` config
- inject runtime repo context into prompt and tools
- treat repo root as config, not inferred memory

### 8. Endless crash/restart loop

Symptom:

- candidate and rollback both fail repeatedly

Mitigation:

- bounded restart attempts
- degraded/manual-intervention mode
- no infinite loops

### 9. Concurrent deploy requests

Symptom:

- race conditions between restart, deploy, rollback

Mitigation:

- serialized request processing
- lock file or single-process ownership

### 10. Agent blocks on fake design choices

Symptom:

- Drost stops progress over packaging structure instead of choosing a sane default

Mitigation:

- bake defaults into the contract
- expose deployer existence and recommended path in runtime context
- do not require human input for incidental structure choices

## V1 Safety Position

V1 should be honest and narrow.

It guarantees:

- failed boots trigger rollback when possible
- known-good state is external and inspectable
- deploy flow is commit-based and auditable

It does not guarantee:

- semantic correctness after a health-success boot
- zero-downtime deploys
- full protection from every possible bad self-edit

## Recommended Safety Defaults

- require exact candidate commit
- serialize requests
- bounded health timeout
- bounded restart attempts
- automatic rollback on failed candidate health
- degraded mode after failed rollback
- external event log for every transition

## Human Override Principle

The operator must always be able to inspect and intervene.

This subsystem should never become clever at the expense of debuggability.

The deployer must be boring, legible, and deterministic.
