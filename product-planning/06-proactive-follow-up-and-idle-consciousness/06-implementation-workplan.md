# Implementation Workplan

## Build Objective

Ship bounded proactive behavior without overcommitting to a full multi-loop runtime.

## Phase 1: Follow-Up Storage Model

### Build

- add canonical JSON storage for follow-ups and responsibilities
- add helper APIs for create, update, list-due, snooze, complete, dismiss
- add idle state file helpers

### Code Touchpoints

- new module: `drost/followups.py`
- new module: `drost/idle_state.py`
- tests under `tests/test_followups.py`

### Acceptance Criteria

- follow-up items can be persisted deterministically
- due-item queries are correct by time and status
- state transitions are tested and inspectable

## Phase 2: Maintenance Extraction Upgrade

### Build

- extend memory maintenance extraction prompt to include `follow_ups`
- resolve extracted entity refs against graph-lite memory where possible
- write follow-up items into canonical storage

### Code Touchpoints

- `drost/memory_maintenance.py`
- `drost/entity_resolution.py`
- tests under `tests/test_memory_maintenance.py`

### Acceptance Criteria

- follow-up-worthy items get extracted and persisted
- low-confidence items are filtered conservatively
- duplicate follow-up spam is suppressed

## Phase 3: Idle State Tracking

### Build

- track active vs idle mode in runtime
- update idle state on inbound/outbound messages
- compute silence thresholds and cooldown windows

### Code Touchpoints

- `drost/gateway.py`
- `drost/channels/telegram.py`
- new module: `drost/idle_state.py`
- tests for mode transitions

### Acceptance Criteria

- user activity moves Drost into active mode immediately
- silence moves Drost into idle mode after threshold
- cooldown windows are respected

## Phase 4: Heartbeat / Drive Loop

### Build

- add bounded idle heartbeat runner
- read due follow-ups, responsibilities, recent graph changes, and recent daily notes
- produce structured decision JSON

### Code Touchpoints

- new module: `drost/idle_heartbeat.py`
- `drost/gateway.py`
- workspace files, especially `HEARTBEAT.md`, as input context
- tests for noop vs proactive decisions

### Acceptance Criteria

- runner triggers only while idle
- runner decisions are bounded and deterministic at the envelope level
- no-op path is cheap and common

## Phase 5: Proactive Telegram Surfacing

### Build

- route approved proactive follow-ups through Telegram
- record surfacing timestamps and cooldowns
- update item state after surfacing

### Code Touchpoints

- `drost/channels/telegram.py`
- `drost/gateway.py`
- `drost/followups.py`
- tests around surfacing and cooldown enforcement

### Acceptance Criteria

- proactive follow-ups send through the existing channel cleanly
- the same item does not resend repeatedly
- active conversation suppresses idle surfacing

## Phase 6: Memory Integration

### Build

- feed due follow-ups into prompt assembly or capsule when relevant
- let conversation turns naturally see due obligations
- allow explicit assistant actions like snooze/complete when the user resolves an item

### Code Touchpoints

- `drost/prompt_assembly.py`
- `drost/agent.py`
- `drost/memory_capsule.py`
- follow-up helper module

### Acceptance Criteria

- follow-up state becomes part of the agent's real situational awareness
- resolved items stop resurfacing
- memory and follow-up systems stay coherent

## Recommended Sequence

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

Reason:

- operational storage must exist before extraction can write anything useful
- idle mode must exist before heartbeat decisions make sense
- surfacing should come only after conservative decision logic exists

## Rollout Strategy

Use feature flags:

- `DROST_FOLLOWUPS_ENABLED`
- `DROST_IDLE_MODE_ENABLED`
- `DROST_IDLE_HEARTBEAT_ENABLED`
- `DROST_PROACTIVE_SURFACING_ENABLED`

Default recommendation:

- ship storage and extraction first
- enable idle tracking next
- keep proactive surfacing off until live transcript review looks good
- then enable proactive surfacing with conservative defaults
