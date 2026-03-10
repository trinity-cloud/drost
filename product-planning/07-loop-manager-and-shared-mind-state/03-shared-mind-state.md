# Shared Mind State

## Purpose

`SharedMindState` is the canonical in-process runtime view that all managed loops read and update through controlled APIs.

It is not the same thing as long-term memory.

Long-term memory remains in:

- Markdown memory files
- SQLite derived index
- transcripts and traces

`SharedMindState` is the live coordination substrate.

## Design Goal

Give every loop the same answer to the same runtime questions:

- Is the user active right now?
- Which chat or session is currently in focus?
- Was a proactive action just taken?
- Is maintenance busy?
- Is the system degraded?
- Are there pending loop-local failures?

## Suggested Canonical Structure

Recommended high-level fields:

```json
{
  "version": 1,
  "mode": "active",
  "focus": {
    "chat_id": 8271705169,
    "session_key": "main:telegram:8271705169__s_2026-03-10_10-00-00",
    "channel": "telegram"
  },
  "activity": {
    "last_user_message_at": "...",
    "last_assistant_message_at": "...",
    "last_proactive_surface_at": "...",
    "proactive_cooldown_until": "..."
  },
  "loop_state": {
    "conversation_loop": {...},
    "maintenance_loop": {...},
    "heartbeat_loop": {...}
  },
  "health": {
    "degraded": false,
    "last_error": ""
  }
}
```

## Ownership Rules

### Conversation Loop Owns

- focus updates
- last user message timestamps
- conversation-active state transitions

### Heartbeat Loop Owns

- last proactive surface timestamp
- heartbeat-specific cooldown state
- last heartbeat decision metadata

### Maintenance Loop Owns

- last extraction run metadata
- maintenance busy/idle flags
- memory update counters

### LoopManager Owns

- canonical runtime mode derivation
- loop liveness view
- degraded-mode state
- event sequencing guarantees

## Persistence Strategy

For v1, shared mind state should be:

- primarily in-memory for fast coordination
- periodically snapshotted to disk under `state/`
- recoverable after restart

Recommended file:

- `state/shared-mind-state.json`

This is not a durable journal. It is a recoverable snapshot.

## Why A Snapshot Is Enough For V1

We do not need a full event-sourced runtime yet.

What matters is:

- loops start from a sane view after restart
- state is inspectable on disk
- coordination is centralized in code while Drost is running

That is enough for the next phase.
