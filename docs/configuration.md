# Configuration

Drost is configured via environment variables with the `DROST_` prefix. All settings can be placed in a `.env` file in the repo root.

## Quick Setup

```bash
cp .env.example .env
```

Edit `.env` with your tokens and preferences.

## Required Settings

| Variable | Description |
|----------|-------------|
| `DROST_TELEGRAM_BOT_TOKEN` | Your Telegram bot token from [@BotFather](https://t.me/BotFather) |

## Provider Settings

You need at least one provider configured.

### OpenAI / Codex (default)

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_DEFAULT_PROVIDER` | `openai-codex` | Active provider |
| `DROST_OPENAI_MODEL` | `gpt-5-codex` | Model name |
| `DROST_OPENAI_API_KEY` | — | API key (if unset, reads Codex OAuth from `~/.codex/auth.json`) |
| `DROST_OPENAI_BASE_URL` | — | Custom API base URL |

### Anthropic

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_ANTHROPIC_TOKEN` | — | API key or Claude Code token |
| `DROST_ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model name |

### xAI / Grok

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_XAI_API_KEY` | — | xAI API key |
| `DROST_XAI_MODEL` | `grok-3-latest` | Model name |
| `DROST_XAI_BASE_URL` | `https://api.x.ai/v1` | API base URL |

## Embedding & Memory

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Gemini API key for embeddings |
| `DROST_MEMORY_EMBEDDING_PROVIDER` | `gemini` | Embedding provider (`gemini`, `openai`, `xai`, `none`) |
| `DROST_MEMORY_EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model |
| `DROST_MEMORY_EMBEDDING_DIMENSIONS` | `3072` | Vector dimensions |
| `DROST_MEMORY_ENABLED` | `true` | Master memory switch |
| `DROST_MEMORY_TOP_K` | `6` | Default search results |
| `DROST_MEMORY_CAPSULE_ENABLED` | `true` | Prompt-time memory capsule |
| `DROST_MEMORY_CAPSULE_SEARCH_LIMIT` | `18` | Capsule candidate pool size |
| `DROST_MEMORY_MAINTENANCE_ENABLED` | `true` | Background memory extraction |
| `DROST_MEMORY_MAINTENANCE_INTERVAL_SECONDS` | `1800` | Maintenance cycle (seconds) |
| `DROST_MEMORY_ENTITY_SYNTHESIS_ENABLED` | `true` | Entity summary generation |
| `DROST_MEMORY_CONTINUITY_ENABLED` | `true` | Session continuity |
| `DROST_MEMORY_CONTINUITY_AUTO_ON_NEW` | `true` | Auto-summarize on `/new` |

## Web Search

| Variable | Description |
|----------|-------------|
| `EXA_API_KEY` | Exa API key for `web_search` tool |

## Follow-Ups & Proactive Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_FOLLOWUPS_ENABLED` | `true` | Extract and track follow-ups |
| `DROST_FOLLOWUP_CONFIDENCE_THRESHOLD` | `0.80` | Min confidence for extraction |
| `DROST_IDLE_MODE_ENABLED` | `true` | Track active/idle mode |
| `DROST_IDLE_HEARTBEAT_ENABLED` | `true` | Background heartbeat loop |
| `DROST_IDLE_HEARTBEAT_INTERVAL_SECONDS` | `1800` | Heartbeat cycle (seconds) |
| `DROST_IDLE_ACTIVE_WINDOW_SECONDS` | `1200` | Seconds before idle transition |
| `DROST_PROACTIVE_SURFACING_ENABLED` | `true` | Allow proactive messages |
| `DROST_PROACTIVE_FOLLOWUP_COOLDOWN_SECONDS` | `21600` | Cooldown between surfaces (6h) |

## Agent Loop

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_AGENT_MAX_ITERATIONS` | `10` | Max loop iterations per run |
| `DROST_AGENT_MAX_TOOL_CALLS_PER_RUN` | `24` | Max external tool calls |
| `DROST_AGENT_TOOL_TIMEOUT_SECONDS` | `30` | Per-tool execution timeout |
| `DROST_AGENT_RUN_TIMEOUT_SECONDS` | `180` | Total run timeout |

For complex agentic work, increase these:

```env
DROST_AGENT_MAX_TOOL_CALLS_PER_RUN=100
DROST_AGENT_MAX_ITERATIONS=100
```

## Context Budget

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_CONTEXT_BUDGET_TOTAL_TOKENS` | `96000` | Total context budget |
| `DROST_CONTEXT_BUDGET_SYSTEM_TOKENS` | `24000` | System prompt budget |
| `DROST_CONTEXT_BUDGET_HISTORY_TOKENS` | `24000` | History budget |
| `DROST_CONTEXT_BUDGET_MEMORY_TOKENS` | `24000` | Memory budget |
| `DROST_CONTEXT_BUDGET_RESERVE_TOKENS` | `24000` | Reserve for response |

## History Compaction

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_HISTORY_COMPACTION_ENABLED` | `true` | LLM-based history summarization |
| `DROST_HISTORY_COMPACTION_TRIGGER_RATIO` | `0.70` | Budget usage ratio that triggers compaction |
| `DROST_HISTORY_COMPACTION_KEEP_RECENT_MESSAGES` | `12` | Recent messages to preserve verbatim |

## Telegram

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_TELEGRAM_BOT_TOKEN` | — | Bot token (required) |
| `DROST_TELEGRAM_ALLOWED_USER_IDS` | — | Comma-separated user IDs (empty = allow all) |
| `DROST_TELEGRAM_WEBHOOK_URL` | — | Webhook base URL (empty = use polling) |
| `DROST_TELEGRAM_WEBHOOK_PATH` | `/webhook/telegram` | Webhook endpoint path |
| `DROST_TELEGRAM_WEBHOOK_SECRET` | — | Webhook verification secret |

## Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_GATEWAY_HOST` | `0.0.0.0` | Bind host |
| `DROST_GATEWAY_PORT` | `8766` | Bind port |
| `DROST_LOG_LEVEL` | `INFO` | Log level |

## Workspace

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_WORKSPACE_DIR` | `~/.drost` | Agent workspace root |
| `DROST_TRACE_ENABLED` | `true` | Enable JSONL tracing |
| `DROST_PROMPT_WORKSPACE_FILES` | `SOUL.md,IDENTITY.md,USER.md,MEMORY.md` | Files injected into system prompt |
