# Reflection Hygiene

## Problem

The reflection loop currently understands diminishing returns, but still writes too many low-value reflections.

That means the model insight exists, but the runtime contract is too weak.

## Goal

Make reflection artifacts rare enough to matter.

The loop should still run.

It should just decide to write less often.

## Anti-Patterns To Eliminate

### 1. Idle Restatement

Examples of bad reflections:

- "nothing changed"
- "session still idle"
- "same as before"

These should not become artifacts.

### 2. Self-Referential Churn

Examples:

- "I have written too many reflections about not needing reflections"

That may be true once.

It should not become a repeated artifact family.

### 3. Non-Actionable Restatement

If a reflection does not sharpen:

- memory
- agenda
- contradiction
- follow-up timing
- user model

it likely should not be written.

## Proposed Runtime Contract

The reflection loop should return one of two classes of outcomes:

1. `write_reflections`
2. `skip_reflection`

`skip_reflection` should be a first-class result, not an implicit empty run.

## Proposed Output Schema

Provider output should become:

```json
{
  "decision": "write_reflections" | "skip_reflection",
  "skip_reason": "optional short reason",
  "reflections": []
}
```

Rules:

- if `decision=skip_reflection`, `reflections` must be empty
- if `decision=write_reflections`, each reflection must clear a higher novelty/value bar

## Write Thresholds

A reflection should only be written if it does at least one of:

### Novelty

- identifies a new stable fact
- identifies a new cross-thread connection
- identifies a changed state

### Tension

- identifies contradiction
- identifies unresolved uncertainty that materially matters

### Agenda Impact

- should add, remove, or reprioritize drive items

### Promotion Signal

- suggests a stable user/identity/memory promotion candidate

## Skip Heuristics

The runtime should support deterministic prefilters before calling the provider:

- no new transcript lines since last reflection
- no memory maintenance changes
- no follow-up changes
- no continuity changes
- no agenda changes

If none of those changed:

- either skip provider call entirely
- or call provider much less frequently on a long idle cadence

## Artifact Strategy

Do not store skips in `reflections.jsonl`.

Instead:

- keep skip counters and last-skip metadata in loop status
- maybe keep a small rolling skip summary in shared state

That preserves observability without polluting artifact history.

## Metrics

Track:

- `reflection_runs_total`
- `reflection_writes_total`
- `reflection_skips_total`
- `reflection_skip_ratio`
- `avg_reflections_per_write_run`
- `consecutive_idle_skip_count`

Target:

- most quiet idle cycles should skip cleanly

## Acceptance Criteria

- long idle periods no longer create reflection spam
- written reflections are materially more novel
- shared mind still knows whether reflection is healthy/stale
- operator can see skip behavior without artifact pollution
