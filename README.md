# Drost

Drost is a stripped-down open-source AI agent gateway built from Morpheus patterns.

It includes:
- FastAPI gateway
- Telegram messaging channel
- Session management
- Persistent memory on SQLite
- sqlite-vec acceleration (`sqvector`-style vector search) with fallback
- Iterative tool-calling agent loop (`LLM -> tools -> LLM`)
- Live Telegram progress updates by editing one in-flight "working" message
- 3 model providers:
  - OpenAI Codex OAuth / OpenAI Responses API
  - Anthropic Claude (API key or Claude Code setup-token)
  - xAI (OpenAI-compatible Responses API)

## License

Apache-2.0 (`LICENSE`).

## Quick Start

1. Install:

```bash
cd /Users/migel/drost
uv sync --extra dev
```

2. Configure:

```bash
cp .env.example .env
# edit .env
```

3. Run:

```bash
uv run drost
```

The gateway starts on `http://0.0.0.0:8766` by default.

## Provider Modes

### 1) OpenAI Codex OAuth (`openai-codex`)

If `DROST_OPENAI_API_KEY` is empty, Drost reads Codex tokens from:
- `~/.codex/auth.json` (or `CODEX_HOME/auth.json`)

It auto-refreshes via OpenAI OAuth refresh token flow.

### 2) Anthropic (`anthropic`)

Set:
- `DROST_ANTHROPIC_TOKEN`

This supports:
- API keys (`sk-ant-...`)
- Claude Code setup-token / OAuth-style tokens (`sk-ant-oat...`)

### 3) xAI (`xai`)

Set:
- `DROST_XAI_API_KEY`

Uses OpenAI-compatible Responses API with:
- `DROST_XAI_BASE_URL` (default `https://api.x.ai/v1`)

## Telegram

Required:
- `DROST_TELEGRAM_BOT_TOKEN`

Optional:
- `DROST_TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs)
- Webhook mode:
  - `DROST_TELEGRAM_WEBHOOK_URL`
  - `DROST_TELEGRAM_WEBHOOK_PATH`
  - `DROST_TELEGRAM_WEBHOOK_SECRET`

If webhook URL is not set, Drost runs Telegram polling.

## Session Commands (Telegram)

- `/new [title]`
- `/sessions`
- `/use <id|index>`
- `/current`
- `/reset`

## Memory

Memory is persisted in:
- `DROST_SQLITE_PATH` (default `~/.drost/drost.sqlite3`)

Embeddings default to Google Gemini:
- `GEMINI_API_KEY`
- `DROST_MEMORY_EMBEDDING_PROVIDER=gemini`
- `DROST_MEMORY_EMBEDDING_MODEL=gemini-embedding-001`
- `DROST_MEMORY_EMBEDDING_DIMENSIONS=3072`

Background transcript-to-memory extraction defaults to:
- `DROST_MEMORY_MAINTENANCE_ENABLED=true`
- `DROST_MEMORY_MAINTENANCE_INTERVAL_SECONDS=1800`
- `DROST_MEMORY_MAINTENANCE_MAX_EVENTS_PER_RUN=200`
- `DROST_MEMORY_ENTITY_SYNTHESIS_ENABLED=true`

Vector mode:
- Attempts to load `sqlite-vec` automatically
- Optional explicit extension path:
  - `DROST_SQVECTOR_EXTENSION_PATH`
- Falls back to brute-force cosine search if extension is unavailable

When embedding dimensions change, Drost rebuilds the derived vector lane automatically.
Incompatible old embedding blobs are cleared so keyword search stays valid and new turns repopulate semantic memory with the new dimension.

Memory maintenance:
- runs once shortly after startup
- then runs in the background on the configured interval
- reads session JSONL transcripts incrementally from `~/.drost/sessions`
- writes durable memory into:
  - `~/.drost/memory/daily/*.md`
  - `~/.drost/memory/entities/*/*/items.md`
- synthesizes touched entities into:
  - `~/.drost/memory/entities/*/*/summary.md`
- stores cursor state in:
  - `~/.drost/state/memory-maintenance.json`

## Workspace Bootstrap

On startup, Drost ensures `~/.drost` exists (or `DROST_WORKSPACE_DIR` when set).

It seeds missing workspace prompt files from in-repo templates on first boot:
- `AGENTS.md`
- `BOOTSTRAP.md` for brand-new workspaces only
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `MEMORY.md`

It also creates:
- `memory/daily/`
- `memory/entities/`

Seed templates are maintained in:
- `drost/bootstrap/workspace/`

Existing files are never overwritten.

## Traces

When `DROST_TRACE_ENABLED=true` (default), run and tool traces are appended to:
- `~/.drost/traces/runs.jsonl`
- `~/.drost/traces/tools.jsonl`

## Session JSONL Transcripts

Drost also writes per-session JSONL transcripts under:
- `~/.drost/sessions/<session_key>.jsonl` (user/assistant only)
- `~/.drost/sessions/<session_key>.full.jsonl` (full turn flow with tool calls/results)

When no active session exists for a chat, Drost auto-creates one using a timestamped
session id (`s_YYYY-MM-DD_HH-MM-SS`), so transcript filenames include datetime by default.

## Gateway Endpoints

- `GET /health`
- `GET /v1/providers`
- `POST /v1/providers/select`
- `GET /v1/sessions/{chat_id}`
- `GET /v1/memory/status`
- `GET /v1/memory/maintenance/status`
- `POST /v1/memory/maintenance/run-once`
- `GET /v1/memory/search?query=...&limit=...`
- `GET /v1/runs/last`
- `POST /v1/chat`
