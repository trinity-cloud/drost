# Loop Contracts And Event Bus

## Why An Event Bus Exists

Polling alone is not enough once loops multiply.

Some events should be explicit so loops can react cheaply and predictably.

Examples:

- user message arrived
- agent reply completed
- memory maintenance wrote new follow-ups
- session continuity artifact completed
- proactive message surfaced
- loop failed or recovered

Without an event bus, every loop ends up re-reading multiple stores too often.

## Event Model

Recommended v1 event envelope:

```json
{
  "event_id": "evt_...",
  "type": "user_message_received",
  "timestamp": "...",
  "scope": {
    "chat_id": 8271705169,
    "session_key": "..."
  },
  "payload": {
    "message_id": 123,
    "channel": "telegram"
  }
}
```

## Required Event Types In V1

### User / Conversation Events

- `user_message_received`
- `assistant_turn_completed`
- `session_switched`

### Memory Events

- `memory_maintenance_completed`
- `followup_created`
- `followup_updated`
- `continuity_written`

### Proactive Events

- `heartbeat_decision_made`
- `proactive_surface_sent`

### Runtime Events

- `loop_started`
- `loop_stopped`
- `loop_failed`
- `loop_recovered`

## Delivery Model

For v1:

- in-process async event dispatcher
- fan-out to subscribed loops
- bounded queue length
- no durability guarantees beyond logs and state snapshots

This is enough because all current loops live in the same runtime process.

## Loop Contracts

Each loop should define:

- which events it subscribes to
- which events it emits
- whether it is tick-driven, event-driven, or hybrid
- whether it may emit user-visible actions

### Conversation Loop

Subscribes to:

- inbound channel events

Emits:

- `user_message_received`
- `assistant_turn_completed`
- `session_switched`

### Maintenance Loop

Subscribes to:

- `assistant_turn_completed`
- optional periodic timer events

Emits:

- `memory_maintenance_completed`
- `followup_created`
- `followup_updated`

### Heartbeat Loop

Subscribes to:

- `followup_created`
- `assistant_turn_completed`
- periodic timer events
- `proactive_surface_sent`

Emits:

- `heartbeat_decision_made`
- `proactive_surface_sent`

## Key Design Constraint

Loops should communicate through shared state and events, not by reaching deep into each other's internals.

That is the actual architectural win.
