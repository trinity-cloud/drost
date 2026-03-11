# Cognitive Artifacts And Shared State

## Why New Artifacts Are Needed

Reflection and drive loops should not hide their cognition entirely in transient in-memory state.

They need explicit artifacts so that:

- the system is inspectable
- internal cognition survives restart appropriately
- prompts can consume bounded summaries instead of recomputing everything
- future loops can build on prior internal work

## Canonical Artifact Set

Recommended v1 artifact files under `~/.drost/state/`:

- `reflections.jsonl`
- `drive-state.json`
- `attention-state.json`

Optional later additions:

- `tensions.jsonl`
- `opportunities.jsonl`
- `suppressed-actions.jsonl`

## Reflections

`reflections.jsonl` should be append-only.

Each row should represent one bounded reflection artifact with source references and review metadata.

This is the internal stream-of-thought substrate Drost can inspect later without storing unsafe raw chain-of-thought.

The artifact should be concise, structured, and operationally useful.

## Drive State

`drive-state.json` should be the canonical active agenda snapshot.

It should include:

- active agenda items
- recent completed/dismissed items
- suppressed items
- next review timestamps
- summary rollups for prompt injection

This should be a replaceable snapshot, not an append-only log.

## Attention State

`attention-state.json` should track runtime attention allocation concepts such as:

- current dominant focus
- top agenda categories
- whether internal cognition is stale
- loop freshness timestamps
- whether conversation currently suppresses deeper background work

This is not long-term memory.

This is live cognitive coordination.

## SharedMindState Extensions

Recommended additions to `SharedMindState`:

```json
{
  "attention": {
    "current_focus_kind": "conversation|reflection|drive|maintenance",
    "current_focus_summary": "...",
    "top_priority_tags": ["health", "self_mod", "memory_quality"],
    "reflection_stale": false,
    "drive_stale": false
  },
  "agenda": {
    "active_count": 4,
    "top_items": [
      {"drive_id": "drv_1", "title": "Tighten deploy validation", "priority": 0.88}
    ],
    "last_drive_update_at": "..."
  },
  "reflection": {
    "last_reflection_at": "...",
    "recent_themes": ["health", "product polish", "self-mod safety"],
    "last_high_importance_reflection_id": "refl_..."
  }
}
```

## Prompt Injection Strategy

Do not inject raw reflection or drive logs wholesale.

Instead inject bounded summaries such as:

- `[Recent Reflections]`
- `[Current Internal Agenda]`

These sections should be compact and derived.

Conversation should benefit from the existence of internal cognition without drowning in raw internal artifacts.

## Ownership Rules

### Reflection Loop Owns

- reflection artifact creation
- reflection summary rollups
- reflection freshness metadata

### Drive Loop Owns

- drive-state snapshot
- agenda prioritization summary
- drive freshness metadata

### LoopManager Owns

- attention arbitration
- degraded-mode gating
- whether cognitive loops may run now or should defer

### Heartbeat Owns

- outward proactive send decisions only
- not agenda creation itself

## Why This Separation Matters

If reflection, drive, and heartbeat all share one undifferentiated state blob, the system will become opaque quickly.

Separate artifacts with clear ownership keep the system debuggable.
