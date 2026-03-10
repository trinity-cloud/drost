<p align="center">
  <img src="docs/assets/drost.png" alt="Drost" width="400">
</p>

<h1 align="center">Drost</h1>

<p align="center">
  <strong>A personal AI agent that actually runs.</strong><br>
  Persistent memory. Iterative tool use. Proactive follow-ups. Supervised runtime.<br>
  All through Telegram.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="docs/architecture.md">Architecture</a> &bull;
  <a href="docs/memory.md">Memory</a> &bull;
  <a href="docs/tools.md">Tools</a> &bull;
  <a href="docs/configuration.md">Configuration</a> &bull;
  <a href="docs/deployer.md">Deployer</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License">
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status">
</p>

---

Most open-source agent projects are either orchestration frameworks that leave you to build the actual agent, or chat wrappers that never develop real continuity, memory, or operational shape.

Drost takes a different position. It's a **complete, opinionated personal agent runtime** — not a framework, not a library, not a thin API wrapper. You run it, it remembers, it follows up, and you can inspect everything it does.

## What Makes Drost Different

**It remembers.** Not just within a session — across sessions, across days, across topics. Drost compounds memory from raw transcripts into structured daily summaries, entity facts, relationships, and summaries. Every turn gets a ranked memory capsule tailored to the current conversation.

**It uses tools iteratively.** Not single-shot function calling. Drost runs a full agent loop: the LLM proposes actions, executes tools, observes results, and keeps going until the task is done. With a structured checklist contract that prevents the agent from losing track of multi-step work.

**It follows up.** Drost extracts concrete follow-ups from conversations — deadlines, action items, promises — and tracks them. When you're idle, a heartbeat loop reviews what's due and can proactively surface reminders through Telegram.

**It's supervised.** A built-in deployer control plane manages the gateway as a subprocess. Health checks, restart, deploy, rollback — all through a request queue that the agent itself can use. The agent can edit its own code and deploy through the control plane.

**It's inspectable.** Every turn is logged as JSONL. Every tool call is traced. Runtime state is a JSON file you can read. A full API surface exposes memory, loops, events, follow-ups, idle state, and run metadata.

## Core Stack

| Component | What It Does |
|-----------|-------------|
| **FastAPI Gateway** | HTTP API + Telegram channel handler |
| **Agent Runtime** | Memory retrieval, prompt assembly, agent loop orchestration |
| **Agent Loop** | Iterative `LLM → tools → LLM` with checklist contract |
| **Loop Manager** | 4 managed loops: conversation, heartbeat, continuity, maintenance |
| **Memory System** | 6-layer memory: transcripts → daily files → entities → index → continuity → capsule |
| **Tool Registry** | 12 built-in tools: memory, files, shell, web, deployer, follow-ups |
| **Deployer** | Subprocess supervisor with health checks, deploy, rollback |
| **Shared Mind State** | Active/idle/cooldown mode tracking for proactive gating |

## Providers

| Provider | Auth | Model |
|----------|------|-------|
| **OpenAI / Codex** (default) | API key or Codex OAuth (`~/.codex/auth.json`) | `gpt-5-codex` |
| **Anthropic** | API key or Claude Code token | `claude-sonnet-4-20250514` |
| **xAI / Grok** | API key | `grok-3-latest` |

Switch providers at runtime via API or configuration. All support streaming, tool use, and vision.

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/drost.git
cd drost
uv sync --extra dev
```

### 2. Configure

```bash
cp .env.example .env
```

Minimum config:

```env
DROST_TELEGRAM_BOT_TOKEN=...       # from @BotFather
EXA_API_KEY=...                    # for web search
GEMINI_API_KEY=...                 # for embeddings
DROST_DEFAULT_PROVIDER=openai-codex
```

For real agentic work, increase the loop limits:

```env
DROST_AGENT_MAX_TOOL_CALLS_PER_RUN=100
DROST_AGENT_MAX_ITERATIONS=100
```

Enable proactive behavior:

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

This starts in supervised mode: the deployer spawns the gateway, monitors health, and handles lifecycle actions.

For direct gateway mode (debugging):

```bash
uv run drost-gateway
```

### 4. Talk to it

Open Telegram, find your bot, send a message. On first boot, Drost runs a bootstrap sequence to establish its identity and learn about you.

### 5. Check health

```bash
curl http://127.0.0.1:8766/health
curl http://127.0.0.1:8766/v1/loops/status
```

## Built-In Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Vector + keyword search across all memory |
| `memory_get` | Read a specific memory file |
| `session_status` | Current session and runtime info |
| `deployer_status` | Deployer state and recent events |
| `deployer_request` | Submit restart / deploy / rollback requests |
| `followup_status` | List outstanding follow-ups |
| `followup_update` | Complete, dismiss, or snooze follow-ups |
| `file_read` | Read files from the filesystem |
| `file_write` | Write files to the filesystem |
| `shell_execute` | Run shell commands |
| `web_search` | Search the web (Exa API) |
| `web_fetch` | Fetch and extract web page content |

## Memory Model

Drost memory is layered, each layer building on the one below:

```
                    ┌─────────────────────┐
                    │  Memory Capsule     │  ← Ranked, bounded, per-turn
                    ├─────────────────────┤
                    │  Graph-Lite         │  ← Entity resolution + neighbors
                    ├─────────────────────┤
                    │  Continuity         │  ← Session handoff summaries
                    ├─────────────────────┤
                    │  Derived Index      │  ← SQLite + sqlite-vec embeddings
                    ├─────────────────────┤
                    │  Workspace Memory   │  ← Markdown: daily, entities, MEMORY.md
                    ├─────────────────────┤
                    │  Session Logs       │  ← Raw JSONL transcripts
                    └─────────────────────┘
```

The maintenance loop compounds raw transcripts into structured memory in the background. The memory capsule builder selects the most relevant fragments for each turn's context window. See [Memory](docs/memory.md) for full details.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new [title]` | Start a new session |
| `/sessions` | List all sessions |
| `/use <id\|index>` | Switch session |
| `/current` | Show active session |
| `/reset` | Clear session transcript |

## Operator API

Key endpoints for monitoring and control:

```bash
GET  /health                          # Health check
GET  /v1/loops/status                 # Consolidated runtime status
GET  /v1/providers                    # Available providers
POST /v1/providers/select             # Switch provider
GET  /v1/memory/status                # Memory statistics
GET  /v1/memory/search?query=...      # Search memory
GET  /v1/followups                    # List follow-ups
GET  /v1/mind/status                  # Shared mind state
GET  /v1/runs/last                    # Last run metadata
POST /v1/chat                         # Send a message via API
```

See [Observability](docs/observability.md) for the full endpoint reference.

## Architecture

```
Telegram ←→ FastAPI Gateway ←→ Agent Runtime ←→ Provider
                                  │
                                  ├→ Loop Manager
                                  │    ├→ Conversation Loop
                                  │    ├→ Heartbeat Loop
                                  │    ├→ Continuity Worker
                                  │    ├→ Maintenance Loop
                                  │    └→ Shared Mind State
                                  │
                                  ├→ Tool Registry (12 tools)
                                  ├→ SQLite Store + sqlite-vec
                                  ├→ Workspace Memory Files
                                  ├→ Session JSONL Logs
                                  └→ Deployer Control Plane
```

See [Architecture](docs/architecture.md) for the full breakdown.

## Workspace

Drost maintains a persistent workspace at `~/.drost` with:

- **Identity files**: `SOUL.md`, `IDENTITY.md`, `USER.md` — define who the agent is
- **Memory files**: `MEMORY.md`, `memory/daily/`, `memory/entities/` — structured knowledge
- **Session logs**: per-session JSONL transcripts
- **Traces**: run and tool-call traces
- **State**: shared mind state, deployer state, follow-ups

On first boot, workspace files are seeded from templates. Existing files are never overwritten. See [Workspace](docs/workspace.md) for details.

## Trust Model

Drost is built for **trusted, self-hosted, single-owner use**.

- File tools can read and write across the host filesystem.
- Shell execution is not sandboxed.
- The runtime is operated by the owner, not exposed as a multi-tenant service.

This is deliberate. Drost optimizes for capability and operational simplicity in personal deployment, not for untrusted-user isolation.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/architecture.md) | System structure and request flow |
| [Memory](docs/memory.md) | Memory layers, maintenance, and capsule building |
| [Tools](docs/tools.md) | Built-in tools and how to add custom ones |
| [Configuration](docs/configuration.md) | Full environment variable reference |
| [Providers](docs/providers.md) | Provider setup and switching |
| [Deployer](docs/deployer.md) | Supervised runtime and control plane |
| [Workspace](docs/workspace.md) | Workspace layout and bootstrap |
| [Telegram](docs/telegram.md) | Telegram setup, commands, and streaming |
| [Observability](docs/observability.md) | Tracing, API endpoints, and event bus |

## Project Status

Drost is **alpha software**. The core is solid and daily-drivable, but the edges are still being refined.

**Strong today:**
iterative agent loop, Telegram UX, multi-provider support, multimodal vision, persistent sessions, transcript logging, compounding memory, entity extraction, session continuity, proactive follow-ups, supervised runtime, managed multi-loop runtime

**Still evolving:**
memory quality tuning, richer graph memory, stronger deploy validation, broader channels, broader tool surface, deeper background cognition

## License

Apache-2.0. See [LICENSE](LICENSE).
