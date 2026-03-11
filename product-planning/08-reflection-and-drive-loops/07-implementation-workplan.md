# Implementation Workplan

## Build Objective

Add reflection and drive loops as internal cognitive loops on top of the managed multi-loop runtime.

## Phase 1: Cognitive Artifact Primitives

### Build

- reflection artifact store
- drive-state snapshot store
- attention-state snapshot helpers
- typed models for reflections and agenda items

### Code Touchpoints

- new module: `drost/cognitive_artifacts.py`
- `drost/shared_mind_state.py`
- tests and docs

### Acceptance Criteria

- reflection and drive artifacts have canonical storage
- artifacts are inspectable on disk
- shared mind state can summarize their freshness and top-level metadata

## Phase 2: Reflection Loop

### Build

- managed `reflection_loop`
- bounded event subscriptions
- provider-backed structured reflection generation
- reflection artifact writing and event emission

### Code Touchpoints

- new module: `drost/reflection_loop.py`
- `drost/loop_manager.py`
- `drost/loop_events.py`
- `drost/gateway.py`

### Acceptance Criteria

- reflections are generated from recent bounded context
- reflections write structured artifacts
- loop emits `reflection_written`
- reflection never messages the user directly

## Phase 3: Drive Loop

### Build

- managed `drive_loop`
- agenda prioritization over follow-ups, reflections, and open threads
- drive-state snapshot generation
- event emission on agenda updates

### Code Touchpoints

- new module: `drost/drive_loop.py`
- `drost/loop_events.py`
- `drost/shared_mind_state.py`
- `drost/gateway.py`

### Acceptance Criteria

- drive loop creates inspectable agenda items
- agenda state is bounded and reviewable
- drive loop does not directly send user-visible actions

## Phase 4: Prompt-Time Cognitive Summaries

### Build

- inject bounded `[Recent Reflections]` and `[Current Internal Agenda]` summaries into conversation prompts
- ensure these sections are compact and relevance-aware

### Code Touchpoints

- `drost/agent.py`
- `drost/prompt_assembly.py`
- helper summarization code

### Acceptance Criteria

- conversation benefits from internal cognition without prompt bloat
- reflection and agenda context is available on normal turns

## Phase 5: Heartbeat Integration

### Build

- heartbeat reads drive-state and recent reflections in addition to due follow-ups
- only heartbeat retains outward initiation rights
- add suppression reasons and audit trail when heartbeat declines to surface something

### Code Touchpoints

- `drost/idle_heartbeat.py`
- `drost/followups.py`
- `drost/shared_mind_state.py`

### Acceptance Criteria

- proactive behavior becomes more intentional
- drive suggestions influence heartbeat decisions without bypassing policy

## Phase 6: Observability And Operator Surface

### Build

- expose reflection and drive loop status under loop endpoints
- expose cognitive artifact freshness and counts
- add recent reflection/agenda summaries to operator surfaces

### Code Touchpoints

- `drost/gateway.py`
- tests and docs

### Acceptance Criteria

- operator can inspect whether internal cognition is running and what it is producing
- stale or noisy cognition is visible quickly

## Recommended Sequence

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

Reason:

- artifacts must exist before loops can write safely
- reflection should come before drive because drive consumes reflections
- prompt-time summaries should come after both loops exist
- heartbeat integration should happen after the internal agenda is real

## Immediate Scope Boundary

Do not build autonomous external task loops in this package.

First prove:

- reflection quality
- drive usefulness
- heartbeat integration quality
- operator inspectability

Only then should Drost consider spawned task loops as a subsequent package.
