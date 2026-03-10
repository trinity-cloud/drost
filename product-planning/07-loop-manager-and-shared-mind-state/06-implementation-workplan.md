# Implementation Workplan

## Build Objective

Migrate Drost from ad hoc concurrent runners to a managed 3-loop runtime.

## Phase 1: Shared Loop Abstraction

### Build

- define managed loop interface and shared loop status shape
- create `LoopManager` skeleton with registration and lifecycle ownership
- define minimal loop priority and visibility enums

### Code Touchpoints

- new module: `drost/loop_manager.py`
- new module: `drost/managed_loop.py`
- `drost/gateway.py`

### Acceptance Criteria

- loop manager can start and stop registered loops cleanly
- loop statuses are inspectable in one place
- gateway owns loop manager instead of individual loop lifecycles

## Phase 2: Shared Mind State

### Build

- define `SharedMindState` in-memory model
- snapshot to `state/shared-mind-state.json`
- move active/idle/focus/proactive cooldown ownership under this model

### Code Touchpoints

- new module: `drost/shared_mind_state.py`
- `drost/idle_state.py`
- `drost/gateway.py`
- `drost/idle_heartbeat.py`

### Acceptance Criteria

- loops read a single authoritative runtime state object
- state survives restarts via snapshots
- old isolated idle-state logic is reduced, not duplicated

## Phase 3: Event Bus

### Build

- add in-process event bus
- define loop subscription model
- emit core events from conversation, maintenance, and heartbeat paths

### Code Touchpoints

- new module: `drost/loop_events.py`
- `drost/agent.py`
- `drost/memory_maintenance.py`
- `drost/idle_heartbeat.py`
- `drost/session_continuity.py`

### Acceptance Criteria

- loops consume runtime events without direct deep coupling
- event delivery is bounded and observable
- existing polling-only coordination is reduced where appropriate

## Phase 4: Migrate Existing Loops Under LoopManager

### Build

- wrap conversation path as managed conversation loop
- wrap memory maintenance as managed maintenance loop
- wrap idle heartbeat as managed heartbeat loop
- keep continuity as managed job class owned by loop manager

### Code Touchpoints

- `drost/gateway.py`
- `drost/agent.py`
- `drost/memory_maintenance.py`
- `drost/idle_heartbeat.py`
- `drost/session_continuity.py`

### Acceptance Criteria

- gateway startup/shutdown uses loop manager only
- loop statuses are centrally visible
- current product behavior remains intact

## Phase 5: Scheduling And Arbitration

### Build

- centralize active vs idle gating
- centralize proactive-send cooldown gating
- centralize single-flight protections for heartbeat send actions
- centralize degraded-mode behavior

### Code Touchpoints

- `drost/loop_manager.py`
- `drost/shared_mind_state.py`
- `drost/idle_heartbeat.py`
- `drost/gateway.py`

### Acceptance Criteria

- conversation suppresses proactive surfacing reliably
- overlapping heartbeat sends are impossible
- maintenance and heartbeat honor centralized policies

## Phase 6: Observability And Operator Surface

### Build

- loop manager status endpoint
- per-loop health and last-event metadata
- event counters and recent-event tail
- degraded-mode visibility

### Code Touchpoints

- `drost/gateway.py`
- new tests and docs

### Acceptance Criteria

- operator can inspect runtime loop state in one place
- failures are visible without digging through logs only

## Recommended Sequence

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

Reason:

- shared contracts must exist before migration
- shared state must exist before real arbitration
- events must exist before loops are decoupled cleanly
- observability should validate the architecture, not precede it

## Immediate Scope Boundary

Do not add reflection or drive loops during this migration.

First ship the manager and migrate the loops Drost already has.

Only after that should new cognitive loops be added.
