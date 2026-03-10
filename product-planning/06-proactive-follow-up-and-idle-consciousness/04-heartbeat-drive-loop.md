# Heartbeat And Drive Loop

## Purpose

The heartbeat/drive loop is the smallest bounded background cognition loop Drost needs right now.

Its job is not deep autonomy. Its job is disciplined review.

Questions it should answer:

- is there anything due?
- is there anything unresolved that matters now?
- is there anything important enough to surface proactively?
- if so, what exactly should be said or done?

## Inputs

The loop should read:

- `memory/follow-ups.json`
- `memory/responsibilities.json`
- recent `memory/daily/*.md`
- recent continuity artifacts
- recent entity summary changes
- current idle state from `state/idle-consciousness.json`

Optional later:

- calendar events
- inbox or external notifications
- deploy/health regressions

## Loop Shape

This should still be one bounded agent loop primitive:

1. gather relevant due items and recent state
2. decide if anything deserves action
3. if yes, produce a structured decision
4. persist the result and optionally initiate

## Decision Output Contract

The heartbeat loop should return structured JSON only.

Suggested output:

```json
{
  "decision": "surface_follow_up",
  "follow_up_id": "followup_2026_03_09_0001",
  "message": "How did the CPAP fitting go?",
  "reason": "Due today and marked high priority health milestone",
  "confidence": 0.94
}
```

Possible decisions:

- `noop`
- `surface_follow_up`
- `surface_digest`
- `snooze_follow_up`
- `mark_expired`
- `create_responsibility`

For v1, only `noop`, `surface_follow_up`, `snooze_follow_up`, and `mark_expired` are necessary.

## Trigger Cadence

Heartbeat should not run constantly.

Recommended v1 cadence:

- every `30` minutes while idle
- immediate run when entering idle
- optional run after maintenance writes new follow-ups

That is enough to feel alive without producing noise or cost blowups.

## Model Tier

This loop does not need a frontier model by default.

Recommended model tier:

- standard or cheap provider path first
- escalate only if the decision is ambiguous

Drost already has provider infrastructure for this later. For v1, even the current active provider is acceptable if the loop is bounded.

## Heartbeat Context Prompt

The system prompt should instruct the loop to be selective.

Core rules:

- do not initiate unless the item is genuinely worth it
- prefer high-signal, low-frequency outreach
- avoid generic check-ins with no concrete reason
- use actual memory context, not vague social filler
- if uncertain, do nothing

## Why This Loop Is Correct

This is not a generic consciousness engine.

It is a bounded review-and-decide loop.

That is exactly the right size for the next phase because it creates the user-facing behavior we want without forcing a full runtime redesign first.
