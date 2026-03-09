# Drost

Drost is an open-source personal AI agent for trusted, owner-operated environments.

It is intentionally stripped down: one gateway, one messaging channel, three providers, a real tool-using loop, multimodal input, persistent sessions, and memory that compounds over time.

Drost is not a chatbot wrapper. It is an agent runtime.

## Why Drost

Most open-source "agents" are one of two things:

- a thin chat UI over a model API
- a framework that gives you abstractions but not a finished personal agent

Drost takes a different position:

- Telegram-native conversational interface
- real iterative tool execution (`LLM -> tools -> LLM`)
- persistent sessions with continuity across `/new`
- durable memory on disk, not just prompt stuffing
- vision support across all providers
- self-hosted workspace under `~/.drost`
- strong observability through JSONL transcripts and run traces

If you want an agent that actually runs, remembers, sees, and acts, this is what Drost is for.

## What Ships Today

### Core runtime

- FastAPI gateway
- Telegram channel with polling or webhook mode
- iterative agent loop with tool calling
- timestamped sessions and session switching
- live Telegram progress updates via one edited working message
- multimodal image + text turns
- Telegram media-group album bundling

### Providers

- `openai-codex`
  - OpenAI Codex OAuth / Responses API flow
- `anthropic`
  - API key or Claude Code setup-token flow
- `xai`
  - OpenAI-compatible Responses API

### Tooling

Drost currently ships with these built-in tools:

- `memory_search`
- `memory_get`
- `session_status`
- `file_read`
- `file_write`
- `shell_execute`
- `web_search`
- `web_fetch`

### Memory

- SQLite-backed memory store
- `sqlite-vec` acceleration with fallback search path
- Gemini embeddings via `gemini-embedding-001` at full `3072` dimensions
- transcript-to-memory background extraction
- daily memory files
- entity fact files
- entity summary synthesis
- session continuity handoff on `/new`
- prompt-time memory capsule built from ranked memory sources

### Observability

- per-session JSONL transcript files
- full JSONL traces including tool calls and tool results
- run traces
- tool traces
- memory maintenance status endpoint
- continuity status endpoint

## Architecture

Drost’s current architecture is intentionally simple:

```text
Telegram <-> FastAPI Gateway <-> Agent Runtime <-> Provider
                                 |
                                 +-> Tool Registry
                                 +-> SQLite Store
                                 +-> JSONL Session Logs
                                 +-> Workspace Memory Files
                                 +-> Background Memory Maintenance
                                 +-> Session Continuity Manager
```

At runtime, a typical turn looks like this:

1. Load workspace context from `~/.drost`
2. Retrieve relevant memory and build a prompt-time memory capsule
3. Run the agent loop
4. Execute tools as needed
5. Persist transcript + traces
6. Let maintenance compound durable memory in the background

## Runtime Topology

Drost injects explicit runtime topology into the agent prompt on every turn.

That includes:

- repo root
- workspace root
- gateway health URL
- launch mode
- start command

The goal is to stop wasting tool calls on rediscovering obvious runtime facts like `pwd`, repo location, or local health endpoints.

## Quick Start

### 1. Install

```bash
cd /Users/migel/drost
uv sync --extra dev
```

### 2. Configure

Create your `.env` in the repo root:

```bash
cp .env.example .env
```

Minimal practical setup:

```env
DROST_TELEGRAM_BOT_TOKEN=...
EXA_API_KEY=...
GEMINI_API_KEY=...
DROST_DEFAULT_PROVIDER=openai-codex
```

Optional but recommended runtime tuning:

```env
DROST_AGENT_MAX_TOOL_CALLS_PER_RUN=100
DROST_AGENT_MAX_ITERATIONS=100
```

### 3. Run

```bash
uv run drost
```

The gateway starts on `http://0.0.0.0:8766` by default.

For local health validation, Drost derives:

- `http://127.0.0.1:8766/health`

## Deployer Skeleton

Drost now ships an external deployer entry point:

```bash
uv run drost-deployer --help
```

Current Phase 2 scope:

- deployer config loading
- external state bootstrap under `~/.drost/deployer`
- status file
- known-good record
- append-only event log
- subprocess child supervision
- operator commands for `start`, `stop`, `restart`, and foreground `run`

Current limitation:

- health-gated promotion and rollback are not implemented yet

## Where Things Live

This is important because Drost has two different roots.

### Repo root

This is where code and runtime config live.

- `.env`
- `README.md`
- `drost/`
- `tests/`

Current local development default:

- `/Users/migel/drost`

### Agent workspace

This is where the agent’s persistent runtime state lives.

Default:

- `~/.drost`

This directory is automatically created on startup. It contains the agent’s workspace, memory, sessions, traces, and attachments.

## Workspace Layout

On first boot, Drost seeds missing workspace files from in-repo templates.

Seeded files:

- `AGENTS.md`
- `BOOTSTRAP.md` for brand-new workspaces only
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

## Provider Setup

### `openai-codex`

If `DROST_OPENAI_API_KEY` is unset, Drost reads Codex OAuth tokens from:

- `~/.codex/auth.json`
- or `CODEX_HOME/auth.json`

It automatically refreshes them when needed.

### `anthropic`

Set:

- `DROST_ANTHROPIC_TOKEN`

Supported token types:

- standard API keys (`sk-ant-...`)
- Claude Code setup-token / OAuth-style tokens (`sk-ant-oat...`)

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

If webhook URL is not configured, Drost uses Telegram polling.

### Telegram commands

- `/new [title]`
- `/sessions`
- `/use <id|index>`
- `/current`
- `/reset`

## Vision

Drost supports image + text turns across all three providers.

Current behavior:

- send a photo with a caption to Telegram
- send an image document with a caption
- send a media-group album
- Drost bundles the images into a single multimodal turn

Providers with vision support in Drost:

- `openai-codex`
- `anthropic`
- `xai`

## Memory Model

Drost’s memory system now has multiple layers.

### 1. Raw session logs

Per-session JSONL files live under:

- `~/.drost/sessions/<session>.jsonl`
- `~/.drost/sessions/<session>.full.jsonl`

These are the source of truth for conversation/debug history.

### 2. Durable workspace memory

Drost compounds memory into Markdown files under `~/.drost`:

- `MEMORY.md`
- `memory/daily/YYYY-MM-DD.md`
- `memory/entities/<type>/<id>/items.md`
- `memory/entities/<type>/<id>/summary.md`

These files are human-readable, editable, and treated as durable memory substrate.

### 3. Unified index

SQLite acts as the derived memory index over:

- transcript messages
- workspace memory files
- continuity summaries

Embedding defaults:

- `GEMINI_API_KEY`
- `DROST_MEMORY_EMBEDDING_PROVIDER=gemini`
- `DROST_MEMORY_EMBEDDING_MODEL=gemini-embedding-001`
- `DROST_MEMORY_EMBEDDING_DIMENSIONS=3072`

Vector mode:

- attempts to load `sqlite-vec` automatically
- optional explicit extension path via `DROST_SQVECTOR_EXTENSION_PATH`
- falls back to brute-force cosine search if the vector extension is unavailable

When embedding dimensions change, Drost rebuilds the derived vector lane automatically. Incompatible old embedding blobs are cleared so keyword search still works and new turns repopulate semantic memory.

## Memory Maintenance

Background memory maintenance is enabled by default.

Key settings:

- `DROST_MEMORY_MAINTENANCE_ENABLED=true`
- `DROST_MEMORY_MAINTENANCE_INTERVAL_SECONDS=1800`
- `DROST_MEMORY_MAINTENANCE_MAX_EVENTS_PER_RUN=200`
- `DROST_MEMORY_ENTITY_SYNTHESIS_ENABLED=true`

What it does:

- runs once shortly after startup
- then runs on the configured interval
- reads new JSONL transcript lines incrementally
- writes daily notes
- writes durable atomic facts into entity folders
- synthesizes touched entity summaries
- reindexes the updated memory files
- stores cursor state in `~/.drost/state/memory-maintenance.json`

## Session Continuity

Drost now carries context across `/new`.

Key settings:

- `DROST_MEMORY_CONTINUITY_ENABLED=true`
- `DROST_MEMORY_CONTINUITY_AUTO_ON_NEW=true`

Behavior:

- `/new` creates the new session immediately
- Drost summarizes the prior session in the background
- the continuity summary is stored as an internal session artifact
- early turns in the new session get that continuity injected into the prompt
- continuity is also indexed as a searchable memory source

## Prompt-Time Memory Capsule

Before each turn, Drost assembles a bounded memory capsule from ranked memory results.

The capsule prefers:

- `MEMORY.md`
- session continuity
- recent daily memory
- entity summaries
- transcript snippets only when higher-order memory is weak

This is what makes Drost feel less like “a model with tools” and more like “an agent with working memory.”

## Traces And Debuggability

When `DROST_TRACE_ENABLED=true` (default), Drost writes:

- `~/.drost/traces/runs.jsonl`
- `~/.drost/traces/tools.jsonl`

This makes agent behavior inspectable instead of opaque.

## HTTP API

Current gateway endpoints:

- `GET /health`
- `GET /v1/providers`
- `POST /v1/providers/select`
- `GET /v1/sessions/{chat_id}`
- `GET /v1/memory/status`
- `GET /v1/memory/maintenance/status`
- `GET /v1/memory/continuity/status`
- `POST /v1/memory/maintenance/run-once`
- `GET /v1/memory/search?query=...&limit=...`
- `GET /v1/runs/last`
- `POST /v1/chat`

## Deployment Model

Drost is built for trusted, self-hosted, single-owner use.

Current assumptions:

- file tools can read and write across the host filesystem
- shell execution is not sandboxed
- the agent is intended to run under the owner’s control, not as a multi-tenant hosted service

That is deliberate. Drost optimizes for capability and simplicity in personal deployment, not for untrusted-user isolation.

## Project Status

Drost is currently alpha software.

What is already strong:

- agent loop
- Telegram UX
- provider support
- vision
- sessions
- transcript logging
- memory foundation
- continuity
- prompt-time recall

What is still evolving:

- memory quality tuning
- graph-lite relationship memory
- richer personality compounding
- broader channels and tool surface

## License

Apache-2.0. See [LICENSE](LICENSE).
