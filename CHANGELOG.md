# Changelog

All notable changes to Drost are documented in this file.

## 0.1.0-rc.1 - 2026-03-01

### Added

- Full P0 session command workflow across channels: `/new`, `/sessions`, `/session <id>`.
- Dual session persistence streams per session: transcript (`.jsonl`) and full event log (`.full.jsonl`).
- Session continuity runtime for asynchronous summary handoff from prior sessions.
- Provider failover with failure classification, retries, cooldown tracking, and status reporting.
- Provider router with route definitions, default route selection, and per-session route overrides.
- Orchestration lane runtime modes (`queue`, `interrupt`, `collect`, `steer`, `steer_backlog`) with persisted lane snapshots.
- Control API (`/control/v1`) read/mutation endpoints with bearer auth scopes and mutation rate limits.
- SSE runtime event stream (`/control/v1/events`).
- Observability JSONL streams for runtime events, tool traces, and usage events.
- Tool policy enforcement (`allowedTools`, `deniedTools`, strict profile defaults) with policy-denied telemetry.
- Retention status and manual prune operations (with dry-run support).
- Dynamic TS module loader fallback for extensionless relative imports in runtime/agent/tool modules.

### Changed

- Control API default auth posture is deny-by-default unless explicit loopback bypass is enabled.
- Session metadata/index now include `providerRouteId` for route continuity across restarts.
- Runtime and operator docs expanded for control API, configuration, and migration guidance.

### Quality

- Added integration tests for provider routing, orchestration persistence, control API throttling, retention prune/status, and tool policy denials.
- Test suite now covers 42 files / 141 tests and passes with build.
