# Quality Hardening And Memory Promotion

## Goal

Take Drost from "architecturally real alpha" to "behaviorally trustworthy alpha."

The next package is not about adding more loops.

It is about tightening the loops and memory systems that now exist:

- reflection hygiene
- heartbeat decision hygiene
- durable memory promotion
- stronger deploy validation
- explicit gating before the next cognition package

## Why This Package Exists

Drost now has real internal cognition:

- `reflection_loop`
- `drive_loop`
- prompt-time cognitive summaries
- heartbeat integration with cognitive state
- operator surfaces for cognition

That is the right foundation.

But the current runtime is showing predictable quality debt:

1. reflections are still too repetitive during idle periods
2. heartbeat observability is noisy with low-value `noop` churn
3. durable memory promotion into `USER.md`, `IDENTITY.md`, and `MEMORY.md` does not exist yet
4. deploy validation is still too weak
5. the next cognition package should be gated on quality metrics, not just on architectural readiness

This package addresses those five points directly.

## Design Thesis

Drost should now shift from subsystem expansion to behavior hardening.

That means:

1. write fewer, better reflections
2. make heartbeat decisions more intentional and less noisy
3. promote stable personal knowledge into canonical workspace files
4. deploy only after a stronger post-restart canary
5. require explicit quality gates before adding more cognition

## Documents

- `01-current-state-and-quality-gaps.md`: where Drost is strong, and where the real quality debt sits
- `02-target-quality-architecture.md`: target runtime shape after this hardening pass
- `03-reflection-hygiene.md`: how to stop low-value reflection churn
- `04-heartbeat-decision-hygiene.md`: how to reduce proactive noise while preserving auditability
- `05-memory-promotion-layer.md`: how durable traits, constraints, and preferences get promoted into workspace memory
- `06-stronger-deploy-canary.md`: how deploy validation should move beyond `/health`
- `07-rollout-and-quality-gates.md`: the implementation order and the gates for future cognition work
- `08-test-observability-and-risks.md`: tests, metrics, operator surfaces, and failure modes

## Current Code Basis

This package is grounded in the current Drost runtime:

- `/Users/migel/drost/drost/reflection_loop.py`
- `/Users/migel/drost/drost/drive_loop.py`
- `/Users/migel/drost/drost/idle_heartbeat.py`
- `/Users/migel/drost/drost/shared_mind_state.py`
- `/Users/migel/drost/drost/cognitive_artifacts.py`
- `/Users/migel/drost/drost/cognitive_summary.py`
- `/Users/migel/drost/drost/memory_maintenance.py`
- `/Users/migel/drost/drost/memory_capsule.py`
- `/Users/migel/drost/drost/gateway.py`
- `/Users/migel/drost/drost/deployer/rollout.py`

## Bottom Line

Drost does not need more architectural ambition right now.

It needs:

1. cleaner cognition
2. sharper memory
3. quieter proactive control
4. safer deploy promotion

Only after those are in place should Drost move to the next cognition package.
