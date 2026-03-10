# Architecture

This document describes how Drost is structured internally, from the entrypoints down to the data layer.

## High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Telegram                                                           │
│  (polling or webhook)                                               │
└──────────────┬──────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│  FastAPI Gateway                                                    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  /health  /v1/chat  /v1/memory/*  /v1/loops/*  /v1/runs/*     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Agent       │  │ Loop Manager │  │ Shared Mind State         │  │
│  │ Runtime     │  │              │  │ (~/.drost/state/)         │  │
│  │             │  │ ┌──────────┐ │  └───────────────────────────┘  │
│  │ ┌─────────┐ │  │ │convo    │ │                                  │
│  │ │ Agent   │ │  │ │heartbeat│ │  ┌───────────────────────────┐  │
│  │ │ Loop    │ │  │ │contin.  │ │  │ Event Bus                 │  │
│  │ │ Runner  │ │  │ │maint.   │ │  └───────────────────────────┘  │
│  │ └─────────┘ │  │ └──────────┘ │                                  │
│  └─────────────┘  └──────────────┘                                  │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Tool        │  │ Provider     │  │ Embedding Service         │  │
│  │ Registry    │  │ Registry     │  │ (Gemini / OpenAI / xAI)   │  │
│  │ (12 tools)  │  │ (3 backends) │  └───────────────────────────┘  │
│  └─────────────┘  └──────────────┘                                  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SQLite Store + sqlite-vec                                    │   │
│  │ Session JSONL  │  Workspace Memory Files  │  Traces          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│  Deployer Supervisor (optional, default)                            │
│  Spawns and supervises the gateway as a child process               │
└─────────────────────────────────────────────────────────────────────┘
```

## Entrypoints

Drost has three entrypoints defined in `pyproject.toml`:

| Command | Module | Purpose |
|---------|--------|---------|
| `drost` | `drost.main:main` | Default. Starts the deployer supervisor, which spawns the gateway. |
| `drost-gateway` | `drost.gateway_main:main` | Starts the FastAPI gateway directly. Use for debugging. |
| `drost-deployer` | `drost.deployer.main:main` | CLI for deployer operations (status, requests, events). |

In normal operation, you run `uv run drost`. The deployer starts `drost-gateway` as a managed subprocess, handles restarts, and provides a control plane for deploy/rollback.

## Request Flow

A typical Telegram message flows through the system like this:

1. **Telegram delivers the message** to the channel handler (polling or webhook).
2. **TelegramChannel** authorizes the user, parses commands (`/new`, `/sessions`, etc.), and routes text/media messages to the gateway's message handler.
3. **Gateway** emits a `user_message_received` event, marks the user as active in idle state, and calls `AgentRuntime.respond()`.
4. **AgentRuntime**:
   - Resolves the session (auto-creates one if needed).
   - Syncs workspace memory index.
   - Embeds the query and searches memory (vector + keyword).
   - Gathers graph-lite entity context (summaries, relations, neighbors).
   - Builds the memory capsule (ranked, source-typed, budget-constrained).
   - Loads session continuity if early in a new session.
   - Prepares history (with optional LLM compaction).
   - Assembles the system prompt (workspace files + tools + memory + follow-ups).
   - Runs the agent loop.
5. **DefaultSingleLoopRunner** executes the iterative loop:
   - Streams LLM response.
   - If the LLM calls tools, dispatches them (internal control tools or external tools via the registry).
   - The LLM manages a mutable checklist and must call `loop_finish` or `loop_blocked` to end.
   - Enforces iteration limits, tool call limits, and timeouts.
6. **AgentRuntime** persists the transcript (SQLite + JSONL), embeds and stores memories, and emits an `assistant_turn_completed` event.
7. **Gateway** marks the assistant as active in idle state and returns the reply to Telegram.
8. **TelegramChannel** renders the response (Markdown to Telegram HTML) and edits/sends the working message.

## Component Overview

### Gateway (`gateway.py`)

The central wiring point. Creates and owns all runtime components:

- `AgentRuntime` — main respond logic
- `LoopManager` — lifecycle for all four managed loops
- `TelegramChannel` — messaging I/O
- `SharedMindState` — mode tracking (active/idle/cooldown)
- `LoopEventBus` — in-process pub/sub
- `MemoryMaintenanceRunner` — background memory extraction
- `SessionContinuityManager` — session handoff summaries
- `IdleHeartbeatRunner` — proactive follow-up surfacing

Mounts FastAPI routes for health, providers, sessions, memory, loops, events, follow-ups, idle state, heartbeat, and chat.

### Agent Loop (`agent_loop.py`)

The iterative tool-use loop. Key design:

- **Checklist contract**: The LLM can create/update/remove checklist items as it works. This provides structured task tracking within a single run.
- **Control tools**: `loop_checklist_patch`, `loop_finish`, `loop_blocked` — these are internal tools that don't count toward the external tool call limit.
- **Streaming**: Streams text deltas and tool calls back to the caller via callbacks.
- **Tracing**: Appends to `runs.jsonl` and `tools.jsonl` in the trace directory.

### Providers (`providers/`)

Three provider backends behind a common `BaseProvider` interface:

- **`openai-codex`** — OpenAI Responses API with Codex OAuth token auto-discovery from `~/.codex/auth.json`.
- **`anthropic`** — Anthropic Messages API with standard API key or Claude Code token.
- **`xai`** — OpenAI-compatible API pointing at `api.x.ai`.

All providers support streaming, tool use, and multimodal (image) input.

### Tool Registry (`tools/`)

12 built-in tools registered per-turn. Each tool implements `BaseTool` with `name`, `description`, `parameters` (JSON Schema), and an async `execute()` method. See [Tools](tools.md) for details.

### Storage (`storage/`)

- **SQLiteStore** — single SQLite database at `~/.drost/drost.sqlite3`. Stores messages, memory rows, entity data, sessions, and continuity records. Uses `sqlite-vec` for vector similarity search with automatic fallback to brute-force cosine.
- **SessionJSONLStore** — per-session `.jsonl` and `.full.jsonl` transcript files under `~/.drost/sessions/`.
- **WorkspaceMemoryIndexer** — syncs Markdown memory files from `~/.drost/` into the SQLite derived index with embeddings.

### Loop Manager (`loop_manager.py`)

Orchestrates four loops with priority-ordered startup/shutdown:

1. **conversation_loop** (foreground) — tracks in-flight turns via event bus.
2. **heartbeat_loop** (background, normal priority) — reviews follow-ups during idle.
3. **continuity_worker** (background, low priority) — generates session summaries.
4. **maintenance_loop** (background, low priority) — extracts durable memory.

Provides degraded-mode gating, proactive single-flight ownership, and aggregated health reporting.
