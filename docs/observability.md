# Observability

Drost is designed to be fully inspectable. Every turn, tool call, and background process is traceable through JSONL logs, API endpoints, and state files.

## JSONL Traces

When tracing is enabled (`DROST_TRACE_ENABLED=true`, the default):

| File | Content |
|------|---------|
| `~/.drost/sessions/<key>.jsonl` | User/assistant message pairs |
| `~/.drost/sessions/<key>.full.jsonl` | Full tool-call trace (all messages including tool calls and results) |
| `~/.drost/traces/runs.jsonl` | Per-run metadata: provider, model, iterations, tool calls, usage, duration, stop reason |
| `~/.drost/traces/tools.jsonl` | Per-tool-call metadata: name, args, duration, error status, result preview |

## API Endpoints

### Runtime Health

```bash
curl http://127.0.0.1:8766/health
# {"status": "ok"}
```

### Consolidated Loop Status

```bash
curl http://127.0.0.1:8766/v1/loops/status
```

Returns:
- Loop manager state (running, degraded, proactive action status)
- Per-loop health (running/failed/stopped/registered counts)
- Failed loop list
- Per-loop runtime details (state, counters, timestamps)
- Mode / focus / activity / health from shared mind state
- Event counts and recent event tail
- Subscriber summary

### Provider Status

```bash
curl http://127.0.0.1:8766/v1/providers
```

### Memory

```bash
curl http://127.0.0.1:8766/v1/memory/status
curl "http://127.0.0.1:8766/v1/memory/search?query=project+deadline&limit=5"
curl http://127.0.0.1:8766/v1/memory/maintenance/status
curl -X POST http://127.0.0.1:8766/v1/memory/maintenance/run-once
curl http://127.0.0.1:8766/v1/memory/continuity/status
```

### Follow-Ups

```bash
curl http://127.0.0.1:8766/v1/followups
curl "http://127.0.0.1:8766/v1/followups?chat_id=123"
```

### Idle & Heartbeat

```bash
curl http://127.0.0.1:8766/v1/idle/status
curl http://127.0.0.1:8766/v1/heartbeat/status
curl -X POST http://127.0.0.1:8766/v1/heartbeat/run-once
```

### Shared Mind State

```bash
curl http://127.0.0.1:8766/v1/mind/status
```

### Event Bus

```bash
curl http://127.0.0.1:8766/v1/events/status
```

### Last Run

```bash
curl http://127.0.0.1:8766/v1/runs/last
```

### Sessions

```bash
curl http://127.0.0.1:8766/v1/sessions/123456789
```

## Event Bus

The in-process event bus carries bounded events that background loops subscribe to:

| Event | Emitted When |
|-------|-------------|
| `user_message_received` | User sends a message |
| `assistant_turn_completed` | Agent finishes responding |
| `session_switched` | User runs `/new` or `/use` |
| `memory_maintenance_completed` | Maintenance loop finishes a cycle |
| `followup_created` | New follow-up extracted |
| `followup_updated` | Follow-up status changed |
| `continuity_written` | Session continuity summary stored |
| `heartbeat_decision_made` | Heartbeat loop makes a decision |
| `proactive_surface_sent` | Proactive message sent to user |

## Shared Mind State

The authoritative runtime state file at `~/.drost/state/shared-mind-state.json` tracks:

- **Mode**: `active` / `idle` / `cooldown`
- **Focus**: current chat ID, session key, channel
- **Activity**: timestamps for last user message, assistant message, heartbeat, proactive surface, idle entry
- **Loop state**: snapshot of all managed loop statuses
- **Health**: degraded flag and last error

This file is the single source of truth for the proactive gate — it determines whether background processes can interrupt the user.
