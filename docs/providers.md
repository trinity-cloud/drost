# Providers

Drost supports three model providers behind a unified interface. All providers support streaming, tool use, and multimodal (image + text) input.

## OpenAI / Codex (default)

The default provider uses the OpenAI Responses API.

**Authentication:**

If `DROST_OPENAI_API_KEY` is set, it uses standard API key authentication.

If no API key is set, Drost reads Codex OAuth tokens from:
- `~/.codex/auth.json`
- or `$CODEX_HOME/auth.json`

This enables zero-config operation if you already have Codex CLI set up.

**Configuration:**

```env
DROST_DEFAULT_PROVIDER=openai-codex
DROST_OPENAI_MODEL=gpt-5-codex
# DROST_OPENAI_API_KEY=sk-...        # optional if using Codex OAuth
# DROST_OPENAI_BASE_URL=...          # optional custom endpoint
```

## Anthropic

Uses the Anthropic Messages API.

**Authentication:**

Set `DROST_ANTHROPIC_TOKEN` to either:
- A standard Anthropic API key (`sk-ant-...`)
- A Claude Code setup token / OAuth-style token

**Configuration:**

```env
DROST_DEFAULT_PROVIDER=anthropic
DROST_ANTHROPIC_TOKEN=sk-ant-...
DROST_ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

## xAI / Grok

Uses an OpenAI-compatible Responses API pointing at `api.x.ai`.

**Configuration:**

```env
DROST_DEFAULT_PROVIDER=xai
DROST_XAI_API_KEY=xai-...
DROST_XAI_MODEL=grok-3-latest
# DROST_XAI_BASE_URL=https://api.x.ai/v1   # default
```

## Switching Providers at Runtime

You can switch the active provider without restarting via the API:

```bash
curl -X POST http://127.0.0.1:8766/v1/providers/select \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic"}'
```

Or check available providers:

```bash
curl http://127.0.0.1:8766/v1/providers
```

## Provider Interface

All providers implement `BaseProvider` with:

- `chat()` — single-shot request/response
- `chat_stream()` — async iterator of `StreamDelta` (content chunks, tool calls, usage)
- `name` / `model` — provider and model identifiers
- `requires_user_followup_turn` — whether continuation turns need a user-role message (Anthropic does)

Tool definitions are converted to each provider's native format automatically.
