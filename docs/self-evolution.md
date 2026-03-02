# Self-Evolution

## What Exists Now

Drost supports mutable repo-workspace evolution:

- framework/runtime code under `packages/`
- custom runtime tools under `.drost/tools/`
- runtime memory/prompt artifacts under `.drost/`
- docs/config and other repo files when needed
- optional `agent.entry`/`runtime.entry` modules when you want hook-style extensions

This keeps the default shape minimal while allowing advanced extension points.

## Current Practical Workflow

Today, the practical workflow is:

1. edit `packages/`, `.drost/` runtime artifacts, or other repo code
2. run validation (`pnpm build`, `pnpm test`)
3. restart runtime (`/restart` or `drost restart`)
4. verify behavior in TUI/plain session

## Safety Posture (Current Default)

Current default runtime is permissive:

- no built-in hard mutation boundary enforcement
- no restart approval/budget/git checkpoint gate
- safety is expected from environment and operational discipline

## What Is Planned (Optional Governance Layer)

Optional governance can still be layered on top:

- structured patch-only mutation workflows
- validation/health gates before restart
- checkpoint/rollback orchestration
- auditable evolution event trails

## Scope Philosophy

Drost separates concerns:

- Framework kernel: lifecycle/safety/runtime substrate
- Repo workspace: mutable behavior code and tools
- Runtime state: `.drost` session/memory/prompt-pack artifacts

This keeps self-evolution powerful while preserving runtime stability.
