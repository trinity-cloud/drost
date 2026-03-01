# Drost

<p align="center">
  <img src="logo.png" alt="Drost logo" width="720" />
</p>

**Drost is an open-source framework for persistent, self-evolving AI agents.**

Current release candidate: `v0.1.0-rc.1`

An agent in Drost is a long-running runtime, not a one-shot prompt wrapper.

## Why Drost

- Persistent gateway process with restart lifecycle
- Session continuity across restarts and provider switches
- Mutable local code and prompts in the same repo
- Built-in and custom tools
- Workspace memory and prompt files
- Terminal-first operation (TUI + plain modes)
- Policy-driven mutation boundaries and operational control surfaces

## Quickstart (Repo = Agent Workspace)

```bash
git clone git@github.com:trinity-cloud/drost.git
cd drost
pnpm install
pnpm build
node packages/cli/dist/bin.js start
```

If you prefer a global command:

```bash
pnpm setup
pnpm -C packages/cli link --global
drost start
```

## Mutable Surfaces

This repository is the agent workspace. In the current runtime, built-in tools can operate repo-wide.
Common mutation targets:

- `packages/` (framework/runtime code)
- `tools/` (custom tools)
- `memory/` (memory/state)
- `prompts/` (system/task prompts)

## Auth Setup

From repo root:

```bash
drost auth doctor

# OpenAI Codex OAuth
codex login
drost auth codex-import openai-codex:default

# Anthropic setup-token
drost auth set-setup-token anthropic:default <token>

# OpenAI-compatible API key (xAI, vLLM, etc.)
drost auth set-api-key openai-compatible openai-compatible:local <api_key>
```

Then verify providers:

```bash
drost providers probe 20000
```

## Current Capabilities

- Gateway lifecycle: `start`, `restart`, health checks, degraded diagnostics
- Optional runtime entry loading (`runtime.entry`)
- Optional agent module loading (`agent.entry`)
- Provider `openai-codex` (Codex CLI OAuth)
- Providers `openai` / `openai-compatible` via **Responses API only**
- Provider `anthropic` (setup-token/OAuth-compatible flow)
- Session persistence + rehydration
- Session continuity handoff and retention policies
- Built-in tools + custom tool loading + tool lifecycle events
- Tool policy enforcement and mutable-root safety boundaries
- Provider routing + failover/cooldown tracking
- Control API (`/control/v1`) + SSE runtime events
- Observability JSONL streams for runtime/tool/usage
- Ink-based TUI and plain CLI mode

## Docs

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Config Reference (P0)](docs/config-reference.md)
- [Control API](docs/control-api.md)
- [Auth & Providers](docs/auth-and-providers.md)
- [Telegram Channel Setup](docs/telegram.md)
- [Runtime Operations](docs/runtime-operations.md)
- [Self-Evolution](docs/self-evolution.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release v0.1.0-rc.1](docs/releases/v0.1.0-rc.1.md)
- [P0 RC1 Migration](docs/migrations/2026-03-01-p0-rc1.md)


## Contributing

```bash
pnpm smoke
pnpm test
pnpm build
```

## License

MIT - see [LICENSE](LICENSE).
