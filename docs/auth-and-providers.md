# Auth and Providers

## Supported Provider Families

- `openai-codex`
- `openai`
- `openai-compatible`
- `anthropic`

## Transport Rules

For `openai` and `openai-compatible` API-key flows, Drost uses the **OpenAI Responses API only**.
There is no Chat Completions fallback.

## Auth Commands

List and diagnose:

```bash
drost auth list
drost auth doctor
```

Set credentials:

```bash
# OpenAI API key
drost auth set-api-key openai openai:default <api_key>

# OpenAI-compatible API key
drost auth set-api-key openai-compatible openai-compatible:local <api_key>

# Anthropic token / setup-token path
drost auth set-setup-token anthropic:default <token>

# Generic token setter (all token-based profiles)
drost auth set-token <provider> <profileId> <token>
```

Codex OAuth import:

```bash
codex login
drost auth codex-import openai-codex:default
```

## Anthropic Notes

Drost supports both:

- Anthropic API key style
- Claude Code setup-token/OAuth style

Setup-token/OAuth requests use bearer + Anthropic beta headers automatically.

## OpenAI-Compatible Notes

Base URLs with or without `/v1` are supported.
Examples:

- `https://api.x.ai`
- `https://api.x.ai/v1`

## Probing and Diagnostics

Startup probes run automatically when enabled.
You can run probes manually:

```bash
drost providers probe 20000
```

Tip: some endpoints need higher timeout than 10s.
Use `providers.startupProbe.timeoutMs` (for example `20000`) for slower providers.

## Session-Scoped Provider Switching

In runtime UI:

- `/session <id>` selects active session
- `/provider <id>` queues provider switch
- switch applies on next turn

Session history remains continuous across provider switches.
