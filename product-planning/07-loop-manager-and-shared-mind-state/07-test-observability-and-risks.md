# Test, Observability, And Risks

## Test Strategy

The multi-loop refactor needs both unit and integration coverage.

## Required Unit Tests

### LoopManager

- registration and duplicate-name rejection
- clean startup and shutdown ordering
- status aggregation
- loop failure reporting

### SharedMindState

- active/idle transitions
- focus updates
- proactive cooldown transitions
- snapshot persistence and restore

### Event Bus

- bounded dispatch
- subscription routing
- per-event fan-out
- no-loop / dropped-event handling

### Arbitration

- conversation suppresses proactive surfacing
- heartbeat cannot send twice for the same follow-up concurrently
- degraded mode disables proactive sends

## Required Integration Tests

- user message arrives while maintenance is running
- follow-up is created, heartbeat reviews it, and surfacing is suppressed because user becomes active
- session switch triggers continuity while conversation remains responsive
- loop manager restart restores shared state snapshot correctly

## Observability Additions

Recommended endpoint:

- `GET /v1/loops/status`

Suggested payload:

```json
{
  "mode": "active",
  "focus": {...},
  "loops": {
    "conversation_loop": {...},
    "maintenance_loop": {...},
    "heartbeat_loop": {...}
  },
  "recent_events": [...],
  "degraded": false
}
```

## Key Metrics

Track at minimum:

- loop start/stop counts
- loop failures and recoveries
- maintenance run duration
- heartbeat decision counts by type
- proactive surfaces sent
- proactive surfaces suppressed due to active mode
- dropped or ignored events

## Main Risks

### 1. Runtime Complexity Drift

A loop manager can easily become an overengineered scheduler.

Mitigation:

- manage only the loops that already exist first
- do not add generalized worker orchestration prematurely

### 2. Split-Brain State

If old local state objects remain authoritative while shared mind state is introduced, the runtime will become inconsistent.

Mitigation:

- explicit ownership rules
- migration plan that deprecates old authority, not duplicates it

### 3. Hidden Race Conditions

As loops get centralized, subtle ordering bugs may surface.

Mitigation:

- event emission points should be explicit
- use per-loop locks where needed
- test active/user-arrival races directly

### 4. User-Facing Regressions

The refactor must not make Drost less responsive or more spammy.

Mitigation:

- keep conversation loop highest priority
- ship with observability before adding new cognitive loops

## Rollout Recommendation

Roll this out behind a feature flag first.

Suggested flag:

- `DROST_LOOP_MANAGER_ENABLED`

Phase the rollout like this:

1. manager exists but only mirrors existing loop status
2. manager owns startup/shutdown
3. manager owns shared mind state
4. manager owns event routing and arbitration

That sequence minimizes blast radius.
