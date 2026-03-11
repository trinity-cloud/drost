# Reflection Loop

## Purpose

The reflection loop answers a simple question:

- what does Drost think about what has happened recently?

This is not the same as extracting facts.

Fact extraction says:

- what was said
- what happened
- what entity changed

Reflection says:

- what matters
- what pattern is emerging
- what is unresolved
- what tension or contradiction should be remembered

## Inputs

Recommended reflection inputs:

- recent assistant/user turns
- recent tool-heavy episodes
- recent memory maintenance output
- recent entity summary changes
- recent continuity artifacts
- recent follow-up creation/update events
- current agenda summary from drive state

The reflection loop should consume bounded windows, not whole history dumps.

## Outputs

The reflection loop should write structured reflection artifacts.

Recommended fields per reflection item:

```json
{
  "reflection_id": "refl_...",
  "timestamp": "...",
  "scope": {
    "chat_id": 8271705169,
    "session_key": "..."
  },
  "kind": "pattern|tension|insight|unresolved|identity_shift",
  "summary": "...",
  "evidence": [
    "memory/entities/people/migel/items.md:23-25",
    "session:main_telegram_...:11"
  ],
  "importance": 0.0,
  "novelty": 0.0,
  "actionability": 0.0,
  "suggested_drive_tags": ["health", "project", "follow_up"],
  "expires_at": null
}
```

## What Counts As A Good Reflection

Examples:

- “Migel tends to move quickly from a technical issue to an architectural principle. This likely means design-level follow-up is more valuable than local patch follow-up.”
- “The TRT conversation surfaced a stable health-management pattern: Migel wants high-precision mechanistic explanations, not vague lifestyle advice.”
- “There is a recurring tension between giving Drost full autonomy and preserving a narrow deploy safety boundary.”
- “The README/public-facing polish work suggests a current operator priority: making Drost legible as a product, not just a repo.”

These are not flat facts. They are interpretations.

## What The Reflection Loop Must Not Do

In v1, reflection must not:

- send messages to the user
- execute arbitrary tools
- mutate code or workspace files directly beyond its own artifact store
- overwrite identity files directly

It may only:

- read bounded context
- call a provider
- write reflection artifacts
- emit internal events

## Triggers

Reflection should be hybrid:

### Event-Driven Triggers

- `assistant_turn_completed`
- `memory_maintenance_completed`
- `continuity_written`
- large graph or summary changes

### Periodic Trigger

- low-frequency idle review, e.g. every 60-120 minutes

## Budgeting

Reflection should be cheap relative to conversation.

Recommended constraints:

- lower model tier than conversation by default
- strict input window caps
- strict output caps
- skip if conversation is active and the queue is stale but low priority

## Why Reflection Matters

Without reflection, Drost compounds facts but not wisdom.

Reflection is the first place where the system starts to develop an inner point of view about ongoing events.
