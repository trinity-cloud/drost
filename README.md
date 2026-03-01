<p align="center">
  <img src="logo.png" alt="Drost logo" width="720" />
</p>

<h3 align="center">The open-source runtime for AI agents that never stop running.</h3>

<p align="center">
  <a href="https://github.com/trinity-cloud/drost/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.1.0--rc.1-blue" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green" /></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/node-22%2B-brightgreen" /></a>
  <a href="https://pnpm.io"><img alt="pnpm" src="https://img.shields.io/badge/pnpm-10%2B-orange" /></a>
</p>

---

Most agent frameworks give you a loop that starts when a user talks and dies when it responds. Drost gives you a **persistent runtime** — a long-running process with sessions, tools, memory, multi-provider routing, and the ability to modify its own code.

Your repository is the agent's workspace. Your tools, prompts, and memory live alongside the runtime. The agent doesn't just execute in your codebase — it *inhabits* it.

## Why Drost

**It stays alive.** Drost runs as a persistent gateway process, not a one-shot script. Sessions survive restarts. State survives crashes. Provider switches happen mid-conversation without losing context.

**It uses any model.** Route conversations through OpenAI, Anthropic, xAI, or any OpenAI-compatible endpoint. Switch providers per session. Failover automatically when one goes down.

**It has hands.** Built-in tools for file operations, code search, shell execution, and git — plus a custom tool system where you drop a file in `tools/` and it's available on the next turn.

**It evolves.** The agent can modify its own code, prompts, and tools at runtime. Changes are validated through build and test gates before they take effect, with automatic rollback on failure.

**It's observable.** A Control API exposes runtime state over HTTP. JSONL streams capture every tool call, provider interaction, and usage metric. SSE endpoints push events in real time.

**It connects.** Channel adapters bring the agent to Telegram, with more channels coming. The same agent, the same sessions, reachable from anywhere.

## Quickstart

```bash
git clone git@github.com:trinity-cloud/drost.git
cd drost
pnpm install
pnpm build
```

Start the runtime:

```bash
node packages/cli/dist/bin.js start
```

Or install globally:

```bash
pnpm setup && pnpm -C packages/cli link --global
drost start
```

Set up a provider:

```bash
# Anthropic
drost auth set-setup-token anthropic:default <your-token>

# OpenAI
drost auth set-api-key openai openai:default <your-key>

# OpenAI-compatible (xAI, vLLM, local models, etc.)
drost auth set-api-key openai-compatible openai-compatible:local <your-key>

# Verify connectivity
drost providers probe 20000
```

## How It Works

```
drost start
  │
  ├─ loads drost.config.ts
  ├─ builds tool registry (built-in + custom + agent-defined)
  ├─ probes configured providers
  ├─ restores persisted sessions
  └─ starts TUI or plain CLI
       │
       ├─ [telegram]  ──┐
       ├─ [cli/tui]   ──┤──→  orchestration  ──→  provider  ──→  tools  ──→  response
       └─ [control api]─┘                              │
                                                  sessions persist
                                                  across restarts
```

The gateway process stays alive. Channels feed messages into an orchestration layer that manages concurrency, routes to providers, executes tool calls, and persists everything. When you restart, sessions rehydrate and the agent picks up where it left off.

## The Workspace Model

Drost treats the repository as a living workspace. The agent can read, write, search, and execute across the entire repo:

```
your-project/
  drost.config.ts        # runtime configuration
  packages/              # framework + your code
  tools/                 # custom tools (drop a file, it loads)
  prompts/system.md      # system prompt (edit to shape behavior)
  memory/                # agent memory and state artifacts
  .drost/
    sessions/            # persisted conversation history
    auth-profiles.json   # provider credentials
```

## Features

### Multi-Provider Routing
Configure multiple LLM providers. Switch between them per session with `/provider <id>`. Automatic failover with cooldown tracking when a provider goes down.

```ts
// drost.config.ts
providers: {
  defaultSessionProvider: "anthropic",
  profiles: [
    { id: "anthropic", kind: "anthropic", model: "claude-sonnet-4-6" },
    { id: "openai", kind: "openai", model: "gpt-5.3-codex" },
    { id: "xai", kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", model: "grok-4-1-fast-reasoning" },
    { id: "local", kind: "openai-compatible", baseUrl: "http://localhost:8000", model: "your-model" },
  ]
}
```

### Session Persistence
Every conversation is persisted to JSONL with atomic writes and file locking. Sessions survive restarts, crashes, and provider switches. History budgets keep storage bounded. Session continuity summaries preserve context across long-running interactions.

### Custom Tools
Create a TypeScript file in `tools/`, export a tool definition, and it's available on the next turn:

```ts
// tools/weather.ts
import { defineTool } from "@drost/core";

export default defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" }
    },
    required: ["city"]
  },
  execute: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${city}?format=j1`);
    return await res.json();
  }
});
```

Or generate one from a template:

```bash
drost tool new my-tool --template fetch
```

### Self-Evolution
The agent can modify its own source code, tools, and prompts at runtime. Changes go through configurable validation gates:

```ts
evolution: {
  enabled: true,
  mutableRoots: ["."],
  validation: { commands: ["pnpm build", "pnpm test"] },
  rollbackOnFailure: true
}
```

If the build breaks, changes roll back automatically.

### Control API
A REST API at `/control/v1` exposes runtime state for external automation, monitoring, and integration:

- `GET /status` — gateway state, provider diagnostics, tool registry
- `GET /sessions` — list active sessions
- `POST /sessions/:id/turn` — submit a turn programmatically
- `GET /events` — SSE stream of runtime events
- Full mutation endpoints for session management, provider switching, and restart

### Channel Adapters
The same agent is reachable from multiple interfaces simultaneously:

- **CLI / TUI** — Ink-based terminal dashboard with streaming, session management, and live event logs
- **Telegram** — Full bot integration with long-polling, streaming message updates, and multi-session support
- **Control API** — Programmatic access for scripts, CI, and external services

### Observability
JSONL streams capture structured events for every runtime operation:

- Tool calls with input/output and timing
- Provider requests with token usage and latency
- Runtime lifecycle events (start, restart, degraded, recovery)
- Per-session usage accounting

## Runtime Commands

Once the agent is running:

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/status` | Gateway state and diagnostics |
| `/providers` | List configured providers |
| `/provider <id>` | Switch provider for current session |
| `/sessions` | List recent sessions |
| `/session <id>` | Switch to a session |
| `/new` | Start a new session |
| `/tools` | List loaded tools |
| `/tool <name> [json]` | Execute a tool directly |
| `/restart` | Request gateway restart |

## Configuration

Drost loads configuration from `drost.config.ts` (or `.js`, `.mjs`, `.json`) in the project root:

```ts
export default {
  workspaceDir: ".",
  providers: { /* ... */ },
  sessionStore: { enabled: true, directory: ".drost/sessions" },
  evolution: { enabled: true, mutableRoots: ["."] },
  health: { enabled: true, port: 0 },
  channels: [ /* telegram, slack, ... */ ]
};
```

See the full [Configuration Reference](docs/config-reference.md) for all options.

## Documentation

- [Getting Started](docs/getting-started.md) — Installation, setup, first run
- [Architecture](docs/architecture.md) — Runtime model, tool access, session/provider design
- [Configuration](docs/configuration.md) — Config file format and loading behavior
- [Config Reference](docs/config-reference.md) — Complete configuration options
- [Auth & Providers](docs/auth-and-providers.md) — Provider setup and credential management
- [Control API](docs/control-api.md) — REST API reference
- [Telegram Setup](docs/telegram.md) — Telegram bot channel configuration
- [Runtime Operations](docs/runtime-operations.md) — CLI commands and runtime behavior
- [Self-Evolution](docs/self-evolution.md) — Code mutation, validation gates, rollback
- [Troubleshooting](docs/troubleshooting.md) — Common issues and diagnostics

## Requirements

- Node.js 22+
- pnpm 10+
- Git

## Contributing

```bash
pnpm install
pnpm build
pnpm test
pnpm smoke
```

See [AGENTS.md](AGENTS.md) for code standards and refactoring guidelines.

## License

MIT — see [LICENSE](LICENSE).
