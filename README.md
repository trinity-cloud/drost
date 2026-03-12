<p align="center">
  <img src="docs/assets/drost.png" alt="Drost" width="500">
</p>

<h1 align="center">Drost</h1>

<p align="center">
  <strong>A personal AI agent that actually runs — and thinks between conversations.</strong><br>
  Persistent memory. Background cognition. Proactive follow-ups. Supervised runtime.<br>
  All through Telegram.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#why-drost">Why Drost</a> &bull;
  <a href="#documentation">Docs</a> &bull;
  <a href="docs/configuration.md">Configuration</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status">
</p>

---

## Why Drost

Most open-source agent projects are either frameworks that leave you to build the actual agent, or chat wrappers that call themselves agents but forget everything between sessions.

Drost is neither. It's a **complete personal agent runtime** you can deploy today.

&nbsp;&nbsp;&nbsp;&nbsp;**It remembers** — across sessions, days, and topics. Raw transcripts are compounded into daily summaries, entity facts, relationships, and ranked memory capsules. Your agent builds knowledge over time, not just within a conversation.

&nbsp;&nbsp;&nbsp;&nbsp;**It acts** — not single-shot function calling, but a full iterative agent loop. The LLM plans, calls tools, observes results, adjusts, and keeps going until the work is done.

&nbsp;&nbsp;&nbsp;&nbsp;**It thinks** — a background cognitive pipeline reflects on recent conversations, notices patterns and tensions, and maintains a self-updating internal agenda. The agent builds its own priorities — not from rules you write, but from what it observes. That context flows into every decision it makes, from what to say next to whether a follow-up is worth interrupting you for.

&nbsp;&nbsp;&nbsp;&nbsp;**It follows up** — extracts deadlines, action items, and promises from conversations. A background heartbeat reviews what's due, consults the agent's internal agenda, and proactively surfaces reminders when you're idle — but only when it's actually worth it.

&nbsp;&nbsp;&nbsp;&nbsp;**It's yours** — self-hosted, single-owner, no cloud dependency. Files, shell, web — full capability without sandbox restrictions. The agent can even edit its own code and deploy changes through a built-in control plane.

&nbsp;&nbsp;&nbsp;&nbsp;**It's inspectable** — every turn logged as JSONL, every tool call traced, runtime state in readable JSON. 20+ operator API endpoints for memory, loops, cognition, quality gates, and runtime health.

## Quick Start

```bash
git clone https://github.com/your-org/drost.git && cd drost
uv sync --extra dev
cp .env.example .env
```

Add your tokens to `.env`:

```env
DROST_TELEGRAM_BOT_TOKEN=...       # from @BotFather
GEMINI_API_KEY=...                 # for embeddings
DROST_DEFAULT_PROVIDER=openai-codex
```

Run:

```bash
uv run drost
```

Open Telegram. Talk to your bot. That's it.

> On first boot, Drost bootstraps itself — it'll ask a few questions to establish its identity and learn about you.

## What's Inside

```
Telegram ←→ Gateway ←→ Agent Runtime ←→ LLM Provider
                            │
                            ├── Agent Loop (LLM → tools → LLM, checklist contract)
                            ├── Memory (6 layers: logs → files → entities → index → continuity → capsule)
                            ├── Cognition (reflection → drive → attention → prompt injection)
                            ├── 12 Built-in Tools (memory, files, shell, web, deployer, follow-ups)
                            ├── 6 Managed Loops (conversation, reflection, drive, heartbeat, continuity, maintenance)
                            ├── Shared Mind State (mode, focus, agenda, attention, heartbeat)
                            └── Deployer (subprocess supervisor, health checks, deploy, rollback)
```

**3 providers** — OpenAI/Codex, Anthropic, xAI/Grok. Switch at runtime. All support streaming, tool use, and vision.

**12 tools** — `memory_search` `memory_get` `session_status` `deployer_status` `deployer_request` `followup_status` `followup_update` `file_read` `file_write` `shell_execute` `web_search` `web_fetch`

**Persistent workspace** at `~/.drost` — identity files, structured memory, session logs, traces, follow-ups, deployer state. Human-readable Markdown, never overwritten.

## Documentation

| | |
|---|---|
| **[Architecture](docs/architecture.md)** | System diagram, request flow, component breakdown |
| **[Cognition](docs/cognition.md)** | Reflection, drive, attention, memory promotion, quality gates |
| **[Memory](docs/memory.md)** | 6 memory layers, maintenance loop, follow-ups, graph-lite |
| **[Tools](docs/tools.md)** | All 12 tools with parameters + how to add custom tools |
| **[Configuration](docs/configuration.md)** | Full environment variable reference |
| **[Providers](docs/providers.md)** | OpenAI/Codex, Anthropic, xAI setup and runtime switching |
| **[Deployer](docs/deployer.md)** | Supervised runtime, control plane, self-modification |
| **[Workspace](docs/workspace.md)** | Filesystem layout, bootstrap, prompt assembly |
| **[Telegram](docs/telegram.md)** | Bot setup, commands, streaming, vision support |
| **[Observability](docs/observability.md)** | JSONL traces, cognition/loop/runtime endpoints, event bus |

Key operator endpoints:
- `/v1/loops/status`
- `/v1/mind/status`
- `/v1/cognition/status`
- `/v1/quality/status`
- `/v1/heartbeat/status`
- `/v1/memory/maintenance/status`

## Status

Drost is **alpha** — daily-drivable, actively developed, not yet stable.

The core works well: agent loop, cognitive pipeline, multi-loop runtime, memory, Telegram UX, multi-provider, vision, sessions, follow-ups, deployer. Cognition depth, memory quality, and tool surface are still evolving.

## License

Apache-2.0
