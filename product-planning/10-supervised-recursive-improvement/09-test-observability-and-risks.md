# Test, Observability, And Risks

## Test Strategy

### 1. Deployer Correctness Tests

Add explicit tests for:

- repo HEAD equals candidate but active runtime differs
- deploy must not noop in that case
- reporting of `requested`, `active`, `healthy`, `noop`, `failed`
- promote immediate semantics

### 2. Worker Supervision Tests

Add tests for:

- worker launch metadata creation
- exact Codex launch command construction
- exact Claude launch command construction
- blocked worker detection
- stale worker detection
- review state persistence
- supervisor reporting only verified outputs
- tmux session naming normalization
- one-write-worker-per-repo enforcement
- multi-job board summary correctness
- worker detail payload correctness

### 3. Foreground Run Discipline Tests

Add tests for:

- self-improvement foreground turns do not spin on long polling
- interrupted worker jobs can be resumed from durable state
- long worker execution does not require keeping the tool loop alive

### 4. Operational Self-Model Tests

Add tests for:

- operational truths promoted into correct docs
- stale runtime/deploy semantics replaced after verified inspection
- no promotion of one-off ephemeral worker state

## Observability Additions

### Operator Endpoints

Consider new or expanded surfaces for:

- `/v1/self-improvement/status`
- `/v1/workers/status`
- `/v1/workers/jobs/<job_id>`
- `/v1/deployer/status` with explicit runtime vs repo fields
- `/v1/quality/status` extended with supervision/reporting gates

### Durable Logs

Need durable logs for:

- worker launches
- worker review outcomes
- worker stdout event streams
- worker stderr streams
- deploy request lifecycle
- deploy no-op reasons
- operational truth promotions

## Main Risks

### 1. Over-Autonomy Drift

If supervision semantics are too loose, Drost will start claiming work it did not verify.

### 2. Control Plane Confusion

If repo state and runtime state remain blurred, deploy reporting will keep failing.

### 3. Worker Trust Leakage

If worker claims are treated as facts, Drost will become overconfident and brittle.

### 3a. Worker Transport Overreach

If tmux becomes the de facto source of truth again, the worker model will regress back into fragile terminal babysitting.

### 4. Prompt Bloat

If operational truths are injected without discipline, the prompt will fill with stale control-plane noise.

### 5. Product Overreach

The emerging recursive-improvement product is real, but still needs conservative rollout.

## Quality Gates Before Next Package

Do not move on to a larger recursive-improvement package until:

1. deploy correctness bug is fixed
2. Drost reports deploy/progress state only from verified state
3. worker supervision can survive interrupted runs
4. operational self-model drift is materially reduced
5. at least one real supervised self-improvement cycle completes cleanly end to end
6. Codex and Claude both complete at least one bounded supervised job through the same worker model

## Bottom Line

This package should end with a Drost that is not just capable of self-improvement, but operationally trustworthy while doing it.
