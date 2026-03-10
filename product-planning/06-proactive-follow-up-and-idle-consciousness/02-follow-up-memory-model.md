# Follow-Up Memory Model

## Canonical Rule

Follow-ups should be file-backed, inspectable, and software-owned.

They should not live only as implicit facts in summaries.

Markdown may remain the human-facing surface, but the canonical operational substrate for due items should be structured JSON because these items have machine-critical fields:

- due time
- state
- priority
- provenance
- dismissal/completion state

## Proposed Canonical Files

Recommended layout under `~/.drost`:

- `memory/follow-ups.json`
- `memory/responsibilities.json`
- `state/idle-consciousness.json`

Optional later:

- `memory/follow-up-log.jsonl`

## Why JSON Here

This is one of the few places where JSON is the right canonical format.

Reason:

- due items need strong machine semantics
- they will be updated by runtime state transitions
- they need deterministic filters by status and due date
- append-only Markdown is weaker for lifecycle state

This does not violate the Markdown-first memory philosophy because follow-ups are operational state, not identity or narrative memory.

## Follow-Up Item Model

Suggested schema:

```json
{
  "id": "followup_2026_03_09_0001",
  "kind": "check_in",
  "subject": "CPAP fitting appointment",
  "entity_refs": [
    "people/migel",
    "projects/health"
  ],
  "source_session_key": "main:telegram:8271705169__s_2026-03-09_10-00-00",
  "source_excerpt": "CPAP fitting appointment tomorrow at 11am",
  "follow_up_prompt": "How did the CPAP fitting go? Did you get the mask you wanted?",
  "due_at": "2026-03-10T19:00:00Z",
  "not_before": "2026-03-10T17:00:00Z",
  "priority": "high",
  "confidence": 0.95,
  "status": "pending",
  "created_at": "2026-03-09T18:00:00Z",
  "updated_at": "2026-03-09T18:00:00Z",
  "completed_at": null,
  "dismissed_at": null,
  "last_surfaced_at": null,
  "suppress_until": null,
  "notes": "Important health milestone"
}
```

## Status Model

Recommended states:

- `pending`
- `surfaced`
- `snoozed`
- `completed`
- `dismissed`
- `expired`

Semantics:

- `pending`: due in the future or due now but not yet surfaced
- `surfaced`: already proactively surfaced, awaiting explicit outcome
- `snoozed`: delayed until a later time
- `completed`: explicitly resolved
- `dismissed`: intentionally ignored or not worth resurfacing
- `expired`: missed the relevance window

## Responsibilities Model

Responsibilities are not one-off follow-ups.

They are ongoing obligations such as:

- check on project stability daily
- review approval status weekly
- revisit a long-running goal periodically

Suggested schema:

```json
{
  "id": "responsibility_deploy_stability",
  "kind": "periodic_review",
  "subject": "Check Drost deploy stability",
  "entity_refs": ["projects/drost", "tools/deployer"],
  "cadence": "P1D",
  "next_due_at": "2026-03-10T18:00:00Z",
  "priority": "medium",
  "status": "active",
  "last_completed_at": "2026-03-09T18:00:00Z"
}
```

## Extraction Output Shape

Memory maintenance should grow a `follow_ups` output field.

Suggested extraction output:

```json
{
  "daily_notes": [...],
  "entities": [...],
  "aliases": [...],
  "facts": [...],
  "relations": [...],
  "follow_ups": [
    {
      "kind": "check_in",
      "subject": "CPAP fitting appointment",
      "entity_refs": ["people/migel"],
      "source_excerpt": "CPAP appointment tomorrow at 11am",
      "follow_up_prompt": "How did the CPAP fitting go?",
      "due_at": "2026-03-10T19:00:00Z",
      "not_before": "2026-03-10T17:00:00Z",
      "priority": "high",
      "confidence": 0.96,
      "notes": "Health milestone"
    }
  ]
}
```

## Resolution Rules

Follow-ups should be deduplicated conservatively.

Safe dedupe keys:

- similar subject
- same primary entity refs
- overlapping due window
- same source session or nearby source excerpts

Do not aggressively merge unrelated future obligations just because they sound similar.

## Why This Model Is Correct

This model cleanly separates:

- narrative memory
- durable factual memory
- relationship memory
- operational future obligations

That separation is necessary if Drost is going to act on time without turning memory into an incoherent blob.
