# Config Reference (P0)

This page focuses on P0 runtime reliability/operations blocks.

## Example

```ts
export default {
  workspaceDir: ".",
  evolution: {
    mutableRoots: ["."]
  },
  sessionStore: {
    enabled: true,
    directory: "./.drost/sessions",
    continuity: {
      enabled: true,
      autoOnNew: true,
      sourceMaxMessages: 40,
      sourceMaxChars: 16000,
      summaryMaxChars: 3000,
      notifyOnComplete: false,
      maxParallelJobs: 2
    },
    retention: {
      enabled: true,
      maxSessions: 250,
      maxTotalBytes: 50000000,
      maxAgeDays: 30,
      archiveFirst: true,
      archiveAfterIdleMs: 1209600000
    }
  },
  orchestration: {
    enabled: true,
    defaultMode: "queue",
    defaultCap: 32,
    dropPolicy: "old",
    collectDebounceMs: 350,
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
    enabled: true,
    maxRetries: 3,
    retryDelayMs: 250,
    backoffMultiplier: 1.5,
    authCooldownSeconds: 900,
    rateLimitCooldownSeconds: 60,
    serverErrorCooldownSeconds: 15
  },
  toolPolicy: {
    profile: "balanced",
    allowedTools: ["file", "code.search", "code.read_context", "code.patch", "shell"],
    deniedTools: ["web"]
  },
  shell: {
    timeoutMs: 20000,
    maxBufferBytes: 500000,
    allowCommandPrefixes: ["pnpm", "git", "node"],
    denyCommandPrefixes: ["rm -rf /", "shutdown", "reboot"]
  },
  controlApi: {
    enabled: true,
    host: "127.0.0.1",
    port: 8788,
    token: process.env.DROST_CONTROL_ADMIN_TOKEN,
    readToken: process.env.DROST_CONTROL_READ_TOKEN,
    allowLoopbackWithoutAuth: false,
    mutationRateLimitPerMinute: 60
  },
  observability: {
    enabled: true,
    directory: "./.drost/observability",
    runtimeEventsEnabled: true,
    toolTracesEnabled: true,
    usageEventsEnabled: true
  }
};
```

## Block Notes

`sessionStore.continuity`

- Schedules async continuity jobs when `/new` creates a new session.
- Appends a bounded continuity summary into the new session history.

`sessionStore.retention`

- Supports age/count/size retention, archive-first behavior, and idle archival.
- Manual prune is available through control API.

`orchestration`

- Controls per-session lane behavior for channel turn scheduling.
- `persistState=true` writes lane snapshots to `.drost/orchestration-lanes.json`.

`providerRouter`

- Defines logical routes from session to provider primary/fallback profiles.
- `defaultRoute` is used unless session override is set.

`failover`

- Governs retry chain behavior, backoff, and cooldown windows.
- Failover status is exposed via control/status APIs.

`toolPolicy`

- `profile`: `strict`, `balanced`, or `permissive` behavior baseline.
- `allowedTools` and `deniedTools` apply gateway-level tool execution guardrails.

`controlApi`

- Exposes `/control/v1` for runtime operations.
- Uses bearer token scope model and mutation rate limiting.

`observability`

- Writes JSONL streams for runtime events, tool traces, and usage events.
- Supports per-stream enable flags.
