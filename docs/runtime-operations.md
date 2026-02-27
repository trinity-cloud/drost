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
- `/status`
- `/tools`
- `/tool <name> [json]`

## Tool Invocation Examples

```text
/tool file {"action":"list","path":"."}
/tool file {"action":"read","path":"prompts/system.md"}
/tool code.search {"query":"defineConfig","literal":true}
/tool code.patch {"patch":"...unified diff...","dryRun":true}
/tool shell {"command":"ls -la"}
/tool web {"action":"fetch","url":"https://example.com"}
/tool agent {"action":"status"}
```

## Default Safety Model

Current default runtime behavior is permissive:

- built-in file/code tools are not hard-limited by `mutableRoots`
- restart path is not gated by approval/budget/git checkpoint policy
- shell tool does not enforce allow/deny prefix lists

Apply environment-level controls when strict isolation is required.

## Restart Contract

- Runtime restart signal uses exit code `42`.
- In foreground `drost start`, the local loop relaunches automatically.
- Service-manager commands (launchd/systemd wrappers) are planned work.

## Session Persistence

When `sessionStore.enabled` is true, session history and metadata persist under configured session directory.

Important:

- if you delete `.drost/sessions`, you start fresh.
- if you keep the project and restart runtime, sessions rehydrate.
