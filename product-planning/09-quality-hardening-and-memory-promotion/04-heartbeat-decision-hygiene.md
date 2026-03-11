# Heartbeat Decision Hygiene

## Problem

Heartbeat is now cognitively informed, but its internal trace is still noisy.

The main offenders are routine negative decisions such as:

- `active_mode`
- `interval_not_elapsed`
- `no_due_followups`

These are operationally valid.

They are just too frequent to remain equally prominent.

## Goal

Keep heartbeat auditable without letting audit and event surfaces turn into low-value noise.

## Target Behavior

### Preserve Full Fidelity For

- actual proactive sends
- provider-authored decisions
- policy-blocked actions
- suppressions caused by drive/agenda guidance
- follow-up expiration or snooze actions
- send failures

### Compress Or Aggregate

- repeated `interval_not_elapsed`
- repeated `active_mode`
- repeated `no_due_followups` during stable idle windows

## Proposed Audit Strategy

Introduce two layers:

### 1. Full Journal

Keep `heartbeat-decisions.jsonl`, but write full rows only for meaningful decisions.

### 2. Aggregated Counters

Track high-frequency trivial suppressions in shared state / loop status:

- `noop_active_mode_count`
- `noop_interval_count`
- `noop_no_due_count`
- `last_meaningful_heartbeat_decision_at`

This keeps the operator view sharp without losing total visibility.

## Decision Semantics

Heartbeat should now reason in three classes:

1. `surface`
2. `suppress`
3. `ignore`

Where:

- `surface` = send something
- `suppress` = concrete candidate existed, but we declined
- `ignore` = nothing meaningful to consider

This is a better operator model than treating everything as generic `noop`.

## Drive-Aware Suppression

The heartbeat should explicitly understand:

- `recommended_channel=heartbeat`
- `recommended_channel=conversation_only`
- `recommended_channel=hold`

Target semantics:

- `heartbeat` = positive surfacing signal
- `conversation_only` = do not proactively interrupt; wait for normal interaction
- `hold` = suppress unless something else materially raises urgency

These should appear explicitly in suppression reasons and audit entries.

## Event Bus Policy

Do not emit `heartbeat_decision_made` with equal weight for every trivial skip.

Options:

1. emit only meaningful decisions
2. emit all decisions, but add `importance=low|normal|high`
3. emit trivial skips less often with coalescing

Recommended v1:

- keep event type stable
- add `importance`
- coalesce repeated trivial skips at the event level if necessary later

## Operator Surfaces

Heartbeat status should expose:

- recent meaningful heartbeat decisions
- current aggregate noop counters
- last proactive send
- current cognitive inputs:
  - active agenda count
  - recent reflection count
  - top drive ids

## Acceptance Criteria

- operators can quickly see why heartbeat is or is not acting
- routine timer churn no longer dominates the audit story
- cognitive suppression reasons are visible
- proactive actions remain fully auditable
