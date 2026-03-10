# Active Vs Idle Runtime

## Core Principle

Drost should not behave like a background thinker while the user is actively talking to it.

Active conversation should take precedence.

Idle cognition should begin only after a bounded silence period.

## Two Runtime Modes

### Active Mode

Active mode means recent user engagement.

Definition for v1:

- a user message arrived within the last `20` minutes

Behavior in active mode:

- normal conversation loop runs as today
- memory maintenance continues normally
- no proactive initiation decisions are sent to the user
- heartbeat/drive review may still update internal state, but does not interrupt

### Idle Mode

Idle mode means no recent user engagement.

Definition for v1:

- no user message for `20` minutes

Behavior in idle mode:

- heartbeat/drive loop becomes eligible to run
- follow-up review becomes eligible
- proactive initiation becomes allowed, subject to policy
- heavy autonomous work remains out of scope for this phase

## State Machine

Suggested state machine:

```text
active
  -> idle_pending      after silence threshold starts approaching
  -> idle              after threshold reached
idle
  -> active            immediately on inbound user message
idle
  -> initiated_recently if Drost proactively reached out
initiated_recently
  -> idle              after cooldown window
  -> active            on user reply
```

For v1, `idle_pending` can remain implicit. The important states are:

- `active`
- `idle`
- `cooldown`

## Canonical State File

Suggested file:

- `state/idle-consciousness.json`

Suggested fields:

```json
{
  "mode": "active",
  "last_user_message_at": "2026-03-09T18:00:00Z",
  "last_assistant_message_at": "2026-03-09T18:01:00Z",
  "entered_idle_at": null,
  "last_heartbeat_at": null,
  "last_proactive_surface_at": null,
  "proactive_cooldown_until": null
}
```

## Transition Rules

### User Message Arrives

Always:

- switch to `active`
- cancel pending idle-initiated surfacing if any
- set `last_user_message_at`

### Silence Threshold Reached

If:

- user has been silent for threshold duration
- no active cooldown
- no outbound proactive message is already pending

Then:

- switch to `idle`
- schedule heartbeat/drive review

### Proactive Message Sent

When Drost initiates:

- record `last_proactive_surface_at`
- set `proactive_cooldown_until`
- remain logically idle, but suppress further proactive surfacing for the cooldown window

## Why The Two-Mode Model Is Right

This is the smallest runtime change that gets the product behavior we want.

It avoids premature complexity:

- no generic loop manager yet
- no full attention allocator yet
- no multi-loop orchestration tree yet

But it does introduce the one runtime distinction that matters:

- talking to the user
- thinking while the user is away

That is enough for the next phase.
