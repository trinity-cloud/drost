# Configuration

Drost loads one of:

- `drost.config.ts`
- `drost.config.mts`
- `drost.config.js`
- `drost.config.mjs`
- `drost.config.json`

## Example

```ts
export default {
  workspaceDir: ".",
  evolution: {
    enabled: true,
    mutableRoots: ["."],
    validation: {
      commands: ["pnpm -r --if-present build", "pnpm test"]
    },
    healthGate: {
      enabled: true,
      timeoutMs: 15000
    },
    rollbackOnFailure: true,
    strictMode: true
  },
  sessionStore: {
    enabled: true,
    directory: "./.drost/sessions"
  },
  health: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/healthz"
  },
  providers: {
    defaultSessionProvider: "openai-codex",
    startupProbe: {
      enabled: true,
      timeoutMs: 20000
    },
    profiles: [
      // provider profiles
    ]
  }
};
```

## Key Fields

- `workspaceDir`: root directory used by runtime tools and persistent state.
- `toolDirectory`: optional override for custom tools directory.
- `authStorePath`: optional override for auth profile store path.
- `agent.entry`: optional agent module path.
- `runtime.entry`: optional runtime module path.
- `evolution`: self-evolution metadata/config (currently advisory in default runtime).
- `sessionStore`: persistent session settings.
- `health`: health endpoint settings.
- `shell`: shell execution settings (`timeoutMs`, `maxBufferBytes`).
- `providers`: provider topology and startup probes.
- `restartPolicy`: restart policy config shape (currently permissive by default runtime behavior).
- `hooks`: gateway lifecycle hooks.

## Provider Profiles

Each profile includes:

- `id`
- `adapterId`
- `kind`
- `baseUrl` (when needed)
- `model`
- `authProfileId`

See [Auth & Providers](auth-and-providers.md).

## Current Reload Behavior

Current hot-reload support is intentionally limited.

Safe reload examples:

- `health`
- `providers.startupProbe`
- `restartPolicy`

Restart-required examples:

- `workspaceDir`
- `toolDirectory`
- provider topology
- `agent` / `runtime`
- `evolution`

## Notes On `evolution` (Current State)

The `evolution` block remains useful for orchestration metadata and forward compatibility.
In current default runtime behavior, built-in tools are not hard-gated by `evolution.mutableRoots`.

See `product-planning/03-self-evolving-agent-code/`.
