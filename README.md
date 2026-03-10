# Drost

Drost is an open-source personal AI agent runtime for trusted, owner-operated environments.

It is built around a simple idea: an agent should not just chat. It should run continuously, use tools, remember across sessions, see images, follow up later, and stay inspectable while it does all of that.

Drost is intentionally narrow:

- one gateway
- one messaging channel
- three model providers
- real persistent memory
- a supervised runtime with a deployer control plane

That constraint is the point. Drost is a productized personal agent, not a generic framework and not a thin chat wrapper over an API.

## Why Drost

Most open-source agent projects fall into one of two buckets:

- orchestration frameworks that still leave you to build the actual agent
- chat shells that call themselves agents but never really develop continuity, memory, or operational shape

Drost takes a different position:

- Telegram-native by default
- iterative tool use, not single-shot prompting
- durable workspace and memory under `~/.drost`
- supervised runtime by default
- explicit observability through JSONL traces, loop status, and operator endpoints
- proactive follow-up and idle-time behavior, not just reactive replies

If you want a personal agent that actually runs, remembers, and can be operated like a real system, that is what Drost is for.

## What Drost Does

### Core Runtime

- FastAPI gateway
- Telegram channel with polling or webhook mode
- iterative agent loop (`LLM -> tools -> LLM`)
- timestamped sessions and session switching
- streaming and working-message updates in Telegram
- vision turns with text + image in one request
- Telegram media-group album bundling
- supervised default startup via the deployer

### Providers

- `openai-codex`
  - OAuth / Responses API flow
- `anthropic`
  - API key or Claude Code setup-token flow
- `xai`
  - OpenAI-compatible Responses API

### Built-In Tools

- `memory_search`
- `memory_get`
- `session_status`
- `deployer_status`
- `deployer_request`
- `followup_status`
- `followup_update`
- `file_read`
- `file_write`
- `shell_execute`
- `web_search`
- `web_fetch`

### Memory

- SQLite-backed memory store
- `sqlite-vec` acceleration with brute-force fallback
- Gemini embeddings via `gemini-embedding-001` at full `3072` dimensions
- transcript-to-memory extraction
- daily memory files
- entity facts, aliases, relations, and summaries
- session continuity on `/new`
- prompt-time memory capsule before each turn
- proactive follow-up tracking and idle heartbeat review

### Runtime Intelligence

- shared mind state under `~/.drost/state/shared-mind-state.json`
- managed loop runtime
- loop event bus
- centralized proactive gating and degraded-mode policy
- graph-lite memory relationships

### Observability

- per-session JSONL transcripts
- full JSONL traces with tool calls and tool results
- run and tool traces
- loop-manager status surface
- shared mind-state status
- event bus status
- memory maintenance and continuity status

## Architecture

```text
Telegram <-> FastAPI Gateway <-> Agent Runtime <-> Provider
                                 |
                                 +-> Loop Manager
                                      +-> Conversation Loop
                                      +-> Heartbeat Loop
                                      +-> Continuity Worker
                                      +-> Maintenance Loop
                                      +-> Shared Mind State
                                      +-> Loop Event Bus
                                 +-> Tool Registry
                                 +-> SQLite Store
                                 +-> Workspace Memory Files
                                 +-> Session JSONL Logs
                                 +-> Deployer Control Plane
```

A normal turn looks like this:

1. Load workspace context from `~/.drost`
2. Retrieve relevant memory and assemble a prompt-time capsule
3. Run the agent loop
4. Execute tools as needed
5. Persist transcript and traces
6. Let maintenance compound durable memory in the background
7. Let the heartbeat and follow-up system react when the user is idle

## Quick Start

### 1. Install

```bash
cd /Users/<user>/drost
uv sync --extra dev
```

### 2. Configure

Create `.env` in the repo root:

```bash
cp .env.example .env
```

Minimum useful config:

```env
DROST_TELEGRAM_BOT_TOKEN=...
EXA_API_KEY=...
GEMINI_API_KEY=...
DROST_DEFAULT_PROVIDER=openai-codex
```

Recommended runtime tuning:

```env
DROST_AGENT_MAX_TOOL_CALLS_PER_RUN=100
DROST_AGENT_MAX_ITERATIONS=100
```

Recommended proactive-memory flags:

```env
DROST_FOLLOWUPS_ENABLED=true
DROST_IDLE_MODE_ENABLED=true
DROST_IDLE_HEARTBEAT_ENABLED=true
DROST_PROACTIVE_SURFACING_ENABLED=true
```

### 3. Run

```bash
uv run drost
```

This is the default supervised mode:

- `drost` starts the deployer
- the deployer starts `drost-gateway`
- restart / deploy / rollback actions go through the deployer control plane

Direct raw gateway mode is still available for debugging:

```bash
uv run drost-gateway
```

### 4. Check Health

Default local health endpoint:

```bash
curl http://127.0.0.1:8766/health
```

## Run Modes

### Default Operator Mode

```bash
uv run drost
```

Use this for normal operation.

### Direct Gateway Mode

```bash
uv run drost-gateway
```

Use this only for debugging or bypassing the deployer.

### Explicit Deployer CLI

```bash
uv run drost-deployer status
uv run drost-deployer requests
uv run drost-deployer events --limit 20
```

## Workspace Model

Drost has two roots.

### Repo Root

This is where code and repo-local runtime configuration live:

- `.env`
- `README.md`
- `drost/`
- `tests/`

Local development default:

- `/Users/<user>/drost`

### Agent Workspace

This is where the agent’s persistent runtime state lives:

- `~/.drost`

It is created automatically on startup.

This directory contains:

- workspace identity and behavior files
- memory files
- sessions
- traces
- attachments
- state snapshots
- deployer state

## Seeded Workspace

On first boot, Drost seeds missing files from in-repo templates.

Seeded files:

- `AGENTS.md`
- `BOOTSTRAP.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `MEMORY.md`

Generated directories:

- `memory/daily/`
- `memory/entities/`
- `sessions/`
- `traces/`
- `attachments/`
- `state/`

Existing files are never overwritten.

## Memory Model

Drost memory is layered.

### 1. Raw Session Logs

Per-session JSONL transcripts live under:

- `~/.drost/sessions/<session>.jsonl`
- `~/.drost/sessions/<session>.full.jsonl`

These are the raw conversational and debugging records.

### 2. Durable Workspace Memory

Drost compounds memory into Markdown under `~/.drost`:

- `MEMORY.md`
- `memory/daily/YYYY-MM-DD.md`
- `memory/entities/<type>/<id>/items.md`
- `memory/entities/<type>/<id>/aliases.md`
- `memory/entities/<type>/<id>/relations.md`
- `memory/entities/<type>/<id>/summary.md`

These are the long-lived human-readable memory substrate.

### 3. Unified Derived Index

SQLite indexes:

- transcript messages
- workspace memory files
- continuity summaries

Embedding defaults:

- `DROST_MEMORY_EMBEDDING_PROVIDER=gemini`
- `DROST_MEMORY_EMBEDDING_MODEL=gemini-embedding-001`
- `DROST_MEMORY_EMBEDDING_DIMENSIONS=3072`

Vector behavior:

- attempts to load `sqlite-vec` automatically
- accepts explicit extension path via `DROST_SQVECTOR_EXTENSION_PATH`
- falls back to brute-force cosine search if unavailable

When embedding dimensions change, Drost rebuilds the derived vector lane automatically.

### 4. Session Continuity

On `/new`, Drost can summarize the previous session and inject the carryover into early turns of the new one.

Continuity is also indexed as a searchable memory source.

### 5. Prompt-Time Memory Capsule

Before each turn, Drost builds a bounded memory capsule from ranked sources.

It prefers:

- `MEMORY.md`
- continuity
- recent daily memory
- entity summaries
- transcript snippets only when higher-order memory is weak

### 6. Follow-Ups And Idle Consciousness

Drost can extract concrete follow-ups into:

- `~/.drost/memory/follow-ups.json`

While the user is idle, the heartbeat loop can:

- review due follow-ups
- decide whether to surface one
- snooze or expire one
- stay conservative when uncertain

This is bounded and policy-gated by the managed runtime.

## Runtime State

Authoritative runtime state lives at:

- `~/.drost/state/shared-mind-state.json`

It tracks:

- active / idle / cooldown mode
- current conversational focus
- recent activity timestamps
- proactive cooldown
- loop snapshots
- runtime health

## Loop Runtime

Drost now runs as a managed multi-loop runtime with four registered loops:

- `conversation_loop`
- `heartbeat_loop`
- `continuity_worker`
- `maintenance_loop`

The loop manager owns:

- startup and shutdown ordering
- centralized degraded-mode state
- proactive-send gating
- proactive single-flight ownership
- aggregated loop health and counters

The event bus carries bounded in-process events such as:

- `user_message_received`
- `assistant_turn_completed`
- `session_switched`
- `memory_maintenance_completed`
- `followup_created`
- `followup_updated`
- `continuity_written`
- `heartbeat_decision_made`
- `proactive_surface_sent`

## Deployer

Drost ships with a built-in local deployer control plane.

It currently provides:

- subprocess supervision
- health checks
- restart
- deploy
- rollback
- known-good tracking
- degraded-mode fallback
- file-backed request queue

Operator commands:

```bash
uv run drost-deployer status
uv run drost-deployer promote
uv run drost-deployer request restart --reason "reload runtime"
uv run drost-deployer request deploy HEAD --reason "candidate self-edit"
uv run drost-deployer request rollback --reason "operator rollback"
```

Active config is written to:

- `~/.drost/deployer/config.toml`

Sample config lives at:

- `examples/deployer.config.toml`

## Providers

### `openai-codex`

If `DROST_OPENAI_API_KEY` is unset, Drost reads Codex OAuth tokens from:

- `~/.codex/auth.json`
- or `CODEX_HOME/auth.json`

### `anthropic`

Set:

- `DROST_ANTHROPIC_TOKEN`

Supported forms:

- standard API key
- Claude Code setup-token / OAuth-style token

### `xai`

Set:

- `DROST_XAI_API_KEY`

Optional:

- `DROST_XAI_BASE_URL` (default `https://api.x.ai/v1`)

## Telegram

Required:

- `DROST_TELEGRAM_BOT_TOKEN`

Optional:

- `DROST_TELEGRAM_ALLOWED_USER_IDS`
- `DROST_TELEGRAM_WEBHOOK_URL`
- `DROST_TELEGRAM_WEBHOOK_PATH`
- `DROST_TELEGRAM_WEBHOOK_SECRET`

If no webhook URL is configured, Drost falls back to polling.

Telegram commands:

- `/new [title]`
- `/sessions`
- `/use <id|index>`
- `/current`
- `/reset`

## Vision

Drost supports multimodal image + text turns across all three providers.

Current supported inputs:

- Telegram photo with caption
- image document with caption
- media-group album

## Operator Surfaces

Primary runtime endpoints:

- `GET /health`
- `GET /v1/providers`
- `POST /v1/providers/select`
- `GET /v1/sessions/{chat_id}`
- `POST /v1/chat`

Memory and runtime endpoints:

- `GET /v1/memory/status`
- `GET /v1/memory/search?query=...&limit=...`
- `GET /v1/memory/maintenance/status`
- `POST /v1/memory/maintenance/run-once`
- `GET /v1/memory/continuity/status`
- `GET /v1/followups`
- `GET /v1/idle/status`
- `GET /v1/heartbeat/status`
- `POST /v1/heartbeat/run-once`
- `GET /v1/mind/status`
- `GET /v1/events/status`
- `GET /v1/loops/status`
- `GET /v1/runs/last`

`GET /v1/loops/status` is the consolidated operator surface. It includes:

- loop-manager policy state
- loop health summary
- failed-loop list
- per-loop runtime details
- current mode / focus / activity / health
- event counts and recent event tail
- subscriber summary

## Observability

Drost is designed to be inspectable.

When tracing is enabled, it writes:

- `~/.drost/sessions/*.jsonl`
- `~/.drost/sessions/*.full.jsonl`
- `~/.drost/traces/runs.jsonl`
- `~/.drost/traces/tools.jsonl`

This gives you both user/assistant transcripts and the full tool-level execution record.

## Trust Model

Drost is built for trusted, self-hosted, single-owner use.

Current assumptions:

- file tools can read and write across the host filesystem
- shell execution is not sandboxed
- the runtime is operated by the owner, not exposed as a multi-tenant hosted service

That is deliberate. Drost optimizes for capability and operational simplicity in personal deployment, not for untrusted-user isolation.

## Project Status

Drost is alpha software.

Already strong:

- iterative agent loop
- Telegram UX
- provider support
- multimodal vision
- persistent sessions
- transcript logging
- compounding memory
- continuity
- proactive follow-up substrate
- supervised runtime and deployer
- managed multi-loop runtime

Still evolving:

- memory quality tuning
- stronger deploy validation than `/health` alone
- richer graph memory quality
- broader channels
- broader tool surface
- further background cognition beyond the current heartbeat / maintenance model

## License

Apache-2.0. See [LICENSE](LICENSE).
