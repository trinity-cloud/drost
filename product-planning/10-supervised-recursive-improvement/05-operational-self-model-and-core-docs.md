# Operational Self-Model And Core Docs

## Problem

Drost repeatedly drifted into stale self-understanding until it re-inspected code or runtime state.

Examples seen in the conversation:

- whether it had background loops
- whether source self-edits were survivable
- whether promote was queued or immediate
- how deploy verification should be reported
- stale repo paths in workspace docs

This is not a missing-memory problem in the broad sense.
It is a missing operational-truth maintenance system.

## Principle

Operational truths should be treated as first-class memory.

That means:

- they should live in canonical workspace docs
- they should be refreshed from verified state
- they should be promoted when stable
- they should not rely on chance retrieval from transcripts

## Target Canonical Sources

### 1. `TOOLS.md`

Should contain:

- deployer semantics
- reporting rules
- worker supervision rules
- repo/workspace/runtime paths
- restrictions on when to trust queued vs active state

### 2. `MEMORY.md`

Should contain:

- stable operating truths
- known failure modes
- recurring lessons about deploy/reporting/supervision

### 3. `AGENTS.md`

Should contain:

- behavioral discipline rules
- when to verify instead of infer
- how to handle self-modification requests

## New Need: Operational Truth Promotion

Extend memory promotion so some extracted truths can target operational docs.

Candidate class:
- `operational_truth`

Examples:
- `promote is immediate, not queued`
- `deploy must be verified against active commit`
- `Codex on this machine can be blocked by macOS approval`
- `Claude Code is available at /Users/migel/.local/bin/claude`

Promotion rules must be strict:

- only stable truths
- only after repeated evidence or direct verified inspection
- no ephemeral one-off state

## Suggested Build

1. define operational-truth category
2. allow promotion into `TOOLS.md` / `MEMORY.md` machine-managed sections
3. add refresh rules for runtime topology and deploy semantics
4. expose a small operator view of current self-model truths

## Acceptance Criteria

- Drost stops repeating stale operational misconceptions
- deploy/runtime/worker truths remain current in core docs
- operator can inspect what operational truths are currently canonical
