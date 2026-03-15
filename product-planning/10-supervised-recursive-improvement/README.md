# Supervised Recursive Improvement

## Goal

Turn Drost's emerging self-improvement behavior from an ad hoc capability into an explicit, reliable product surface.

This package is not about adding another generic cognition loop.

It is about tightening the operational layer around self-inspection, external-worker supervision, deploy semantics, reporting discipline, and self-model maintenance.

## Why This Package Exists

The latest live conversation showed five important truths:

1. Drost is strong at diagnosis and architectural reasoning, but weak at execution control under long, tool-heavy runs.
2. There is a real deployer correctness bug around candidate deploy no-op behavior.
3. Drost's operational self-model still drifts and must be refreshed from reality more reliably.
4. The external-worker supervision path for Codex and Claude exists, but is not productionized.
5. A larger product is emerging: supervised recursive improvement.

This package captures all five explicitly.

## Design Thesis

Drost is no longer just a personal agent with memory.

It is becoming a supervised self-improving runtime that can:

- inspect itself
- plan changes to itself
- delegate implementation to external coding workers
- review and validate the results
- deploy through a control plane
- recover when rollout fails
- update its own operating model from what actually happened

That behavior needs first-class architecture, not scattered heuristics.

## Documents

- `01-current-state-and-product-signal.md`: what the latest conversation revealed about Drost's current maturity
- `02-target-product-and-runtime-shape.md`: the desired end-state for supervised recursive improvement
- `03-execution-control-and-run-discipline.md`: how Drost should stop wasting loop budget and control long-running work
- `04-deployer-semantics-and-rollout-correctness.md`: deploy, promote, rollback, reporting, and the active-commit vs repo-HEAD bug
- `05-operational-self-model-and-core-docs.md`: how Drost keeps its own deploy/runtime/worker model current
- `06-supervised-external-worker-model.md`: Codex and Claude as bounded workers under Drost supervision, including exact launch commands, tmux conventions, and multi-job operator UX
- `07-recursive-improvement-product-surface.md`: the bigger product shape that is emerging from these capabilities
- `08-implementation-workplan.md`: the recommended build order across all five themes
- `09-test-observability-and-risks.md`: validation strategy, operator surfaces, and failure modes

## Current Code Basis

This package is grounded in the current runtime and the latest live traces:

- `/Users/migel/drost/drost/agent.py`
- `/Users/migel/drost/drost/agent_loop.py`
- `/Users/migel/drost/drost/gateway.py`
- `/Users/migel/drost/drost/deployer/rollout.py`
- `/Users/migel/drost/drost/deployer/service.py`
- `/Users/migel/drost/drost/deployer/client.py`
- `/Users/migel/drost/drost/tools/deployer_request.py`
- `/Users/migel/drost/drost/shared_mind_state.py`
- `/Users/migel/drost/drost/followups.py`
- `/Users/migel/.drost/sessions/main_telegram_8271705169__s_2026-03-11_23-38-36.jsonl`
- `/Users/migel/.drost/sessions/main_telegram_8271705169__s_2026-03-11_23-38-36.full.jsonl`

## Bottom Line

The next meaningful step for Drost is not more subsystem sprawl.

It is making supervised self-improvement:

- operationally disciplined
- semantically correct
- externally verifiable
- teachable to itself
- safe enough to become a default workflow
