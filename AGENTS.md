# AGENTS.md

## Purpose

Repository-wide engineering standards for sustainable refactoring and maintainability.

## File Size Standards (TypeScript)

These are practical standards, not rigid universal limits.

1. Core business modules/services:
- Target: `150-350` LOC
- Soft cap: `400` LOC
- Hard review trigger: `>500` LOC

2. Orchestrators/controllers/gateways:
- Target: `200-450` LOC
- Soft cap: `500` LOC
- Hard review trigger: `>700` LOC

3. Integration adapters/protocol handlers:
- Target: `250-600` LOC
- Soft cap: `650` LOC
- Hard review trigger: `>800` LOC

4. Types/schema-only files:
- Target: `200-800` LOC
- Soft cap: `900` LOC
- Hard review trigger: `>1000` LOC

5. Test files:
- Target: `200-700` LOC
- Soft cap: `800` LOC
- Hard review trigger: `>1000` LOC

## Refactor Requirements

1. No functional regressions.
2. Keep behavior and API contracts stable unless explicitly approved.
3. Preserve existing tests; add targeted tests when moving logic.
4. After each major extraction step, run:
- `pnpm -r --if-present build`
- `pnpm test`
- `pnpm smoke` (or targeted smoke suites if equivalent)

## Refactor Heuristics

1. Extract by subsystem first (control API, session ops, orchestration, tools) rather than by utility micro-splits.
2. Prefer cohesive modules over many tiny files.
3. Keep each module's public surface explicit and minimal.
4. Avoid circular dependencies between runtime subsystems.
5. Do not introduce behavior changes masked as refactors.

## PR/Commit Policy

1. Keep commits coherent by subsystem.
2. Include validation evidence in commit messages or PR notes.
3. If a file exceeds its soft cap after refactor, document why and what follow-up split is planned.
