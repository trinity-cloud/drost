# Drive Loop

## Purpose

The drive loop answers a different question:

- given what Drost knows now, what deserves attention next?

This is not task execution.

This is agenda formation.

## Inputs

Recommended drive inputs:

- due follow-ups
- recent reflections
- open continuity threads
- current graph changes
- active goals and responsibilities
- recent user-declared priorities
- recent suppressed heartbeat actions

## Outputs

The drive loop should produce agenda artifacts, not direct user-facing actions.

Recommended agenda item shape:

```json
{
  "drive_id": "drv_...",
  "timestamp": "...",
  "kind": "goal|responsibility|opportunity|open_thread|concern",
  "title": "...",
  "summary": "...",
  "priority": 0.0,
  "urgency": 0.0,
  "confidence": 0.0,
  "source_refs": ["refl_...", "followup:fu_..."],
  "recommended_channel": "heartbeat|conversation_only|hold",
  "next_review_at": "...",
  "status": "active"
}
```

## Drive Categories

Recommended initial categories:

- `goal`
  - explicit user or system goals that need continued attention
- `responsibility`
  - recurring obligations or standing commitments
- `open_thread`
  - issues that remain unresolved after conversation
- `opportunity`
  - useful possible next steps surfaced by reflection or memory
- `concern`
  - risks, contradictions, or degradations that should not be forgotten

## What The Drive Loop Should Decide

The drive loop should classify candidate agenda items into one of three lanes:

- `heartbeat_candidate`
  - potentially worth proactive surfacing later
- `conversation_only`
  - should only be used if the user re-engages on a related topic
- `hold`
  - worth tracking internally, but not worth surfacing now

This gives later loops something usable without granting direct initiative rights too early.

## What The Drive Loop Must Not Do

In v1, the drive loop must not:

- message the user directly
- call `deployer_request`
- call `shell_execute`
- spawn external task loops
- mutate repo files or workspace files directly outside its own artifacts

It may only:

- read cognitive inputs
- write agenda state
- emit internal events like `drive_updated`

## Triggers

Drive should be triggered by:

- `followup_created`
- `followup_updated`
- `memory_maintenance_completed`
- `reflection_written`
- periodic idle review

## Why The Drive Loop Exists

Without a drive loop, Drost can remember and reflect but still lacks direction.

The drive loop is where priorities become explicit and inspectable.

That is a prerequisite for any later task-loop or autonomous work system.
