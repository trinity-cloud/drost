# Drost

Drost is a stripped-down open-source AI agent gateway built from Morpheus patterns.

It includes:
- FastAPI gateway
- Telegram messaging channel
- Session management
- Persistent memory on SQLite
- sqlite-vec acceleration (`sqvector`-style vector search) with fallback
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

Vector mode:
- Attempts to load `sqlite-vec` automatically
- Optional explicit extension path:
  - `DROST_SQVECTOR_EXTENSION_PATH`
- Falls back to brute-force cosine search if extension is unavailable

## Gateway Endpoints

- `GET /health`
- `GET /v1/providers`
- `POST /v1/providers/select`
- `GET /v1/sessions/{chat_id}`
- `GET /v1/memory/status`
- `GET /v1/memory/search?query=...&limit=...`
- `POST /v1/chat`
