# Runtime Operations

## Start Modes

Primary flow: run from the repo root (`drost` checkout), which is the agent workspace.

```bash
drost start --ui auto
drost start --ui tui
drost start --ui plain
```

`auto` uses TUI when running in a TTY and falls back to plain mode otherwise.

## Core CLI Commands

```bash
drost start [--ui <auto|tui|plain>]
drost restart

drost auth doctor
drost auth list
drost auth codex-import [profileId]
drost auth set-api-key <provider> <profileId> <apiKey>
drost auth set-token <provider> <profileId> <token>
drost auth set-setup-token <profileId> <token>

drost providers list
drost providers probe [timeoutMs]

drost tool list-templates
drost tool new <name> [--template <id>]
```

## In-Session Commands

- `/help`
- `/restart`
- `/providers`
- `/provider <id>`
- `/session`
- `/session <id>`
- `/sessions`
- `/new`
- `/status`
- `/tools`
- `/tool <name> [json]`

## Tool Invocation Examples

```text
/tool file {"action":"list","path":"."}
/tool file {"action":"read","path":".drost/loops/prompt-packs/conversation/AGENTS.md"}
/tool code.search {"query":"defineConfig","literal":true}
/tool code.patch {"patch":"...unified diff...","dryRun":true}
/tool shell {"command":"ls -la"}
/tool web {"action":"fetch","url":"https://example.com"}
/tool agent {"action":"status"}
```

## Default Safety Model

Current runtime safety is policy-driven:

- built-in file/code/shell operations enforce mutable-root boundaries.
- shell tool can be constrained with allow/deny command prefixes.
- tool execution can be constrained with `toolPolicy`.
- restart flow remains configurable through `restartPolicy`.

## Restart Contract

- Runtime restart signal uses exit code `42`.
- In foreground `drost start`, the local loop relaunches automatically.
- Service-manager commands (launchd/systemd wrappers) are planned work.

## Session Persistence

When `sessionStore.enabled` is true, session history and metadata persist under configured session directory.

Important:

- each session stores both transcript and full event logs (`.jsonl` + `.full.jsonl`).
- if you keep the project and restart runtime, sessions rehydrate.
- if you are upgrading from older pre-P0 state, reset `.drost` once.

See [P0 RC1 Migration](migrations/2026-03-01-p0-rc1.md).
