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
    directory: "./.drost/sessions",
    continuity: {
      enabled: true
    },
    retention: {
      enabled: true,
      maxSessions: 250
    }
  },
  orchestration: {
    enabled: true,
    defaultMode: "queue",
    persistState: true
  },
  providerRouter: {
    enabled: true,
    defaultRoute: "route-default",
    routes: [
      {
        id: "route-default",
        primaryProviderId: "openai-main",
        fallbackProviderIds: ["anthropic-fallback"]
      }
    ]
  },
  failover: {
    enabled: true
  },
  toolPolicy: {
    profile: "balanced"
  },
  controlApi: {
    enabled: true,
    host: "127.0.0.1",
    port: 8788,
    token: process.env.DROST_CONTROL_ADMIN_TOKEN,
    readToken: process.env.DROST_CONTROL_READ_TOKEN,
    allowLoopbackWithoutAuth: false
  },
  observability: {
    enabled: true,
    directory: "./.drost/observability"
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
- `toolPolicy`: gateway-level tool allow/deny and profile controls.
- `orchestration`: channel lane mode/cap/drop/persistence settings.
- `providerRouter`: session route-to-provider mapping and defaults.
- `failover`: retry/cooldown policy for provider fallback behavior.
- `controlApi`: authenticated `/control/v1` server options.
- `observability`: JSONL telemetry stream settings.
- `plugins`: plugin runtime module loading, trust roots, and allowlist controls.
- `skills`: skill discovery roots, allow/deny gating, and injection policy.
- `subagents`: asynchronous delegated-job runtime controls.
- `optionalModules`: optional memory/graph/scheduler/backup runtime controls.
- `providers`: provider topology and startup probes.
- `restartPolicy`: restart policy, budget, and git checkpoint controls.
- `hooks`: gateway lifecycle hooks.

For full runtime blocks and examples, see [Config Reference](config-reference.md).

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
- `failover`
- `plugins` / `skills` / `subagents` / `optionalModules`
- `agent` / `runtime`
- `evolution`

## Mutable Roots and Tool Boundaries

Built-in file/code/shell operations enforce mutable-root boundaries.

- default mutable root: `workspaceDir`
- override roots: `evolution.mutableRoots`

Tool policy and shell prefix policy can further restrict execution.
