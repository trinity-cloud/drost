# Troubleshooting

## `drost: command not found`

If linked from source:

```bash
pnpm setup
pnpm -C packages/cli link --global
```

Ensure `PNPM_HOME` is on your shell `PATH`.

## `ERR_PNPM_NO_GLOBAL_BIN_DIR`

Run:

```bash
pnpm setup
```

Restart shell, then retry global link.

## Startup Shows `missing_auth`

This means the current workspace auth store does not have the requested profile yet.
Run:

```bash
drost auth list
drost auth doctor
```

Then set required profiles (`set-api-key`, `set-setup-token`, or `codex-import`).

## Auth Profiles Missing After Changing Workspace

Expected behavior: auth store is workspace-scoped by default.
If you switch to a different repo/workspace, profiles are separate unless you intentionally share `authStorePath`.

## `local-openai-compatible` Probe `unreachable` / `This operation was aborted`

Increase probe timeout in `drost.config.ts`:

```ts
providers: {
  startupProbe: {
    enabled: true,
    timeoutMs: 20000
  }
}
```

Then restart and rerun:

```bash
drost providers probe 20000
```

## Session Looks Fresh Every Time

If you delete `.drost/sessions`, sessions are new.
If you keep the same project and session store path, sessions rehydrate across runtime restarts.

## Writes Seem Blocked Even Though Drost Is Permissive

Drost itself is permissive by default in current runtime behavior.
If writes are blocked, the restriction is usually external:

- provider-side sandboxing
- container/VM mount permissions
- OS user permissions / filesystem ACLs

Verify by running:

```bash
drost auth doctor
drost providers probe 20000
```

Then inspect provider/runtime environment constraints.

## Provider Probes: How To Inspect Quickly

```bash
drost providers list
drost providers probe 20000
drost auth doctor
```

## Runtime Build/Type Errors During Development

From repo root:

```bash
pnpm test
pnpm build
```

## Still Blocked

Capture and share:

- `drost auth doctor`
- `drost providers probe 20000`
- first 30-50 lines of `drost start` output
- relevant `drost.config.ts` provider block
