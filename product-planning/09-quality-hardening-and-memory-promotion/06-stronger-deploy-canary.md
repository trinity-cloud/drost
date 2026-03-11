# Stronger Deploy Canary

## Problem

The deployer currently treats gateway liveness as the primary promotion signal.

That is not strong enough.

## Goal

Promote only when the runtime is not merely alive, but actually usable.

## Target Canary Ladder

The deployer should validate in layers.

### Canary 1: Process Health

- child process started
- gateway bound successfully
- `/health` responds

This is the current baseline.

### Canary 2: Runtime Surface Health

- `GET /v1/loops/status`
- `GET /v1/mind/status`
- `GET /v1/cognition/status`

This catches broken runtime initialization beyond bare liveness.

### Canary 3: Provider Round-Trip

Execute a minimal provider call with a tiny bounded prompt.

This should verify:

- provider client initialization
- prompt assembly path
- model reachability

### Canary 4: Tool Round-Trip

Execute one minimal tool-enabled turn.

Recommended target:

- `session_status`

Reason:

- cheap
- deterministic
- exercises the tool loop without external side effects

### Canary 5: Memory Surface Sanity

Optional but recommended:

- `GET /v1/memory/status`
- maybe a trivial memory search path if data exists

## Promotion State Machine

Recommended deploy flow:

1. checkout candidate ref
2. start child
3. wait for `/health`
4. run runtime surface canaries
5. run provider canary
6. run tool canary
7. if all pass:
   - mark candidate known-good
8. else:
   - rollback automatically

## Canary Design Rules

### Cheap

Canaries must be fast enough to run on every supervised deploy.

### Deterministic

Avoid canaries that depend on:

- live web search freshness
- Telegram external timing
- large memory variability

### Side-Effect Minimal

Canaries should not write user-visible content or mutate important state.

### Separate Failure Labels

The deployer should distinguish:

- `gateway_unhealthy`
- `runtime_surface_failed`
- `provider_canary_failed`
- `tool_canary_failed`
- `rollback_failed`

## Operator Surface

The deployer status should expose:

- last canary phase reached
- last canary failure label
- last canary latency
- last known-good commit

## Acceptance Criteria

- a process that is alive but broken will not be promoted
- rollback triggers on real runtime regressions
- deploy failures are easy to classify
- deployer trust materially improves
