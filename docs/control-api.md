# Control API

The gateway can expose an authenticated control surface at `/control/v1`.

## Enable

```ts
export default {
  workspaceDir: ".",
  controlApi: {
    enabled: true,
    host: "127.0.0.1",
    port: 8788,
    token: process.env.DROST_CONTROL_ADMIN_TOKEN,
    readToken: process.env.DROST_CONTROL_READ_TOKEN,
    allowLoopbackWithoutAuth: false,
    mutationRateLimitPerMinute: 60
  }
};
```

## Auth Model

- `admin` token (`controlApi.token`): read + mutation access.
- `read` token (`controlApi.readToken`): read-only access.
- missing/invalid token: `401`.
- read token on mutation endpoint: `403`.

Header format:

```http
Authorization: Bearer <token>
```

## Security Defaults

- Deny by default.
- Keep `allowLoopbackWithoutAuth=false` for production.
- Bind to loopback (`127.0.0.1`) unless fronted by a trusted proxy.
- Set `mutationRateLimitPerMinute` to throttle control mutations.

## Endpoint Reference

Read endpoints:

- `GET /control/v1/status`
- `GET /control/v1/sessions`
- `GET /control/v1/sessions/:id`
- `GET /control/v1/sessions/retention`
- `GET /control/v1/providers/status`
- `GET /control/v1/orchestration/lanes`
- `GET /control/v1/plugins/status`
- `GET /control/v1/skills`
- `GET /control/v1/subagents/jobs`
- `GET /control/v1/subagents/jobs/:id`
- `GET /control/v1/subagents/jobs/:id/logs`
- `GET /control/v1/optional/status`
- `GET /control/v1/events` (SSE)

Mutation endpoints:

- `POST /control/v1/sessions`
- `POST /control/v1/sessions/:id/switch`
- `POST /control/v1/sessions/:id/route`
- `POST /control/v1/sessions/:id/skills`
- `POST /control/v1/sessions/prune`
- `POST /control/v1/subagents/start`
- `POST /control/v1/subagents/jobs/:id/cancel`
- `POST /control/v1/chat/send`
- `POST /control/v1/backup/create`
- `POST /control/v1/backup/restore`
- `POST /control/v1/runtime/restart`

## Examples

Read status:

```bash
curl -s \
  -H "Authorization: Bearer $DROST_CONTROL_READ_TOKEN" \
  http://127.0.0.1:8788/control/v1/status
```

Create a session with route:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $DROST_CONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"local","providerRouteId":"route-default"}' \
  http://127.0.0.1:8788/control/v1/sessions
```

Send chat turn:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $DROST_CONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"local-20260301-010203-000","input":"hello"}' \
  http://127.0.0.1:8788/control/v1/chat/send
```

Dry-run prune:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $DROST_CONTROL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"policy":{"enabled":true,"maxSessions":10}}' \
  http://127.0.0.1:8788/control/v1/sessions/prune
```

SSE stream:

```bash
curl -N \
  -H "Authorization: Bearer $DROST_CONTROL_READ_TOKEN" \
  http://127.0.0.1:8788/control/v1/events
```

## Operational Notes

- Runtime events are also mirrored to observability JSONL when enabled.
- SSE sends an initial `snapshot` event followed by `runtime` deltas.
- Mutation throttling is bucketed per remote/token key.
