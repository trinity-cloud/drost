# Architecture

## Runtime Model

Drost runs as a practical single codebase in repo-workspace mode:

1. Runtime layer
- CLI start loop + gateway lifecycle
- provider/session/tool orchestration

2. Repository workspace layer
- `packages/` source code
- `tools` custom tool files
- `memory` files
- `prompts` files
- persisted sessions/auth data

## What Executes On `drost start`

At startup:

1. CLI loads `drost.config.*` from current project root.
2. Gateway loop starts.
3. Optional runtime entry module runs if `runtime.entry` is configured.
4. Optional agent entry module is imported if `agent.entry` is configured.
5. Tool registry is built in this order:
- built-in tools
- optional agent module tools
- workspace custom tools
6. Provider probes run.
7. TUI/plain loop begins.

## Project Isolation

Repository workspace contains:

- `drost.config.ts`
- `packages/*`
- `tools/`, `memory/`, `prompts/`
- local auth store (`.drost/auth-profiles.json`)

## Tool Access Model

Current default behavior is intentionally permissive:

- no workspace path escape blocking in built-in file/code tools
- no enforced `evolution.mutableRoots` mutation boundary in built-in tools
- no restart approval/budget/git checkpoint gate in restart path

Use environment-level controls (OS user permissions, containerization, CI policy) if you need hard safety walls.

## Session and Provider Model

- Provider selection is per session.
- Switching providers applies on the next turn.
- Session history persists and remains provider-agnostic.
- Startup probes report provider diagnostics before first turn.

## Related Docs

- [Configuration](configuration.md)
- [Auth & Providers](auth-and-providers.md)
- [Self-Evolution](self-evolution.md)
