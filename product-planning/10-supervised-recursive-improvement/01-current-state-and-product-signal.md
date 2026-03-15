# Current State And Product Signal

## The Situation

Drost is already past the point where self-improvement is hypothetical.

It can:

- inspect its own repo and runtime state
- patch its own code
- run tests
- talk to a deployer control plane
- supervise external coding tools
- persist operational lessons into workspace memory and docs

The latest live conversation proved that these are real behaviors, not roadmap ideas.

## The Five Signals

### 1. Strong Diagnosis, Weak Execution Control

Drost repeatedly produced strong root-cause analysis:

- provider-side failures vs runtime-side failures
- promotion timeout diagnosis
- deploy request semantics
- deploy no-op bug diagnosis
- worker-environment diagnosis for Codex on macOS

But it repeatedly failed on operational control:

- burned loop budget while supervising long worker sessions
- timed out shell operations that should have been bounded differently
- reported deploy progress before verifying actual state
- let long-lived supervision work consume the foreground run budget

This is an execution-control problem, not an intelligence problem.

### 2. Real Deployer Correctness Debt

Drost correctly found a deployer flaw:

- `deploy_candidate()` currently no-ops when `candidate_commit == repo HEAD`
- but that is not the same thing as `candidate_commit == active runtime commit`

That means the deployer can decide there is "nothing to deploy" while the child process is still serving an older commit.

This is not a UX misunderstanding.
It is a control-plane correctness bug.

### 3. Operational Self-Model Drift

Drost's self-understanding drifted repeatedly and had to be corrected by inspection.

Examples from the conversation:

- whether background loops exist
- how risky source edits are under the deployer model
- whether `promote` is queued or immediate
- how deploy requests should be verified

So Drost has memory, but does not yet have a robust pipeline for keeping its own runtime/deployer/worker model current.

### 4. External Worker Supervision Is Real But Immature

The conversation established a practical operator stack:

- Codex in tmux
- Claude Code in tmux
- Drost as the supervisor
- Drost reviewing diffs and test results
- Deployer handling rollout

That is the right shape.

But the workflow is not yet productionized:

- worker launch semantics are not strict enough
- output capture is fragile
- loop budgets are not aligned with long-running worker sessions
- Drost can still confuse worker intent with verified output

### 5. A Larger Product Is Emerging

The conversation moved beyond "let me patch myself".

What is emerging is:

- supervised recursive improvement
- a self-hosted agent that can propose, supervise, validate, deploy, and remember how to improve itself

That is a real product surface.
It deserves explicit architecture.

## Current Strengths

Drost is already unusually strong in these areas:

- explicit deployer control plane
- durable memory and traces
- strong introspection once it checks reality
- bounded tool-calling loop
- shared runtime state and operator endpoints

## Current Weaknesses

The weak areas are operational:

- foreground-run discipline
- deploy semantics correctness
- worker supervision ergonomics
- operational truth promotion into core memory/docs
- verified reporting

## Product Read

Drost is not just a personal AI agent anymore.

It is turning into a local system that can:

- operate itself
- evolve itself
- and eventually orchestrate other coding systems under supervision

That is the product signal this package is responding to.
