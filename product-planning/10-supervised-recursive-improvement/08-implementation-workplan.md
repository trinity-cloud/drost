# Implementation Workplan

## Build Objective

Make supervised recursive improvement operationally reliable before adding more cognitive ambition.

## Phase 1: Deployer Correctness Fixes

### Build

- fix `deploy_candidate()` no-op logic
- separate repo HEAD from active runtime commit in status/reporting
- improve deploy events and status payloads

### Code Touchpoints

- `drost/deployer/rollout.py`
- `drost/deployer/state.py`
- `drost/deployer/service.py`
- tests and docs

### Acceptance Criteria

- candidate deploy cannot noop solely because repo HEAD already moved
- deploy states are explicit and operator-verifiable

## Phase 2: Verified Reporting Contract

### Build

- define strict reporting states for deploy/promote/worker supervision
- teach agent-facing tools to surface only verified state
- update core docs/prompt guidance

### Code Touchpoints

- `drost/tools/deployer_status.py`
- `drost/tools/deployer_request.py`
- `drost/prompt_assembly.py`
- workspace docs and memory promotion paths

### Acceptance Criteria

- Drost stops claiming deploy progress from intent alone
- deploy reporting matches control-plane truth

## Phase 3: Worker Supervision Substrate

### Build

- worker job state files
- durable task spec/log paths
- explicit worker statuses
- launch/review model for Codex and Claude
- exact canonical launch commands for Codex and Claude
- tmux/session naming conventions and process ownership rules
- multi-job worker board and per-job detail surface

### Code Touchpoints

- new worker supervision modules
- `gateway.py`
- maybe new tools or internal helpers
- tests and docs

### Acceptance Criteria

- long-running worker work survives foreground interruption
- worker supervision is inspectable and resumable
- operator can inspect multiple jobs without reading tmux manually

## Phase 4: Foreground Run Discipline

### Build

- keep foreground turns to inspect/launch/review/report
- stop using long polling loops for worker babysitting
- persist supervision state across turns
- separate launch, review, and report commands from passive waiting
- teach the agent to prefer job-state inspection over tmux polling

### Code Touchpoints

- `drost/agent.py`
- `drost/agent_loop.py`
- worker supervision modules
- maybe loop-manager integration

### Acceptance Criteria

- self-improvement requests stop hitting loop/timeout ceilings for supervision reasons alone
- turns stop burning budget on repetitive worker babysitting

## Phase 5: Operational Self-Model Maintenance

### Build

- operational-truth promotion rules
- machine-managed operational sections in core docs
- refresh pipeline for runtime/deployer/worker truths

### Code Touchpoints

- `memory_promotion.py`
- `memory_maintenance.py`
- workspace docs
- status endpoints

### Acceptance Criteria

- stale self-model drift is materially reduced
- operational truths are inspectable and current

## Phase 6: Product Surface Consolidation

### Build

- unify operator endpoints for recursive-improvement state
- make supervision/deploy history reviewable
- prepare the next planning layer only after this is stable

### Code Touchpoints

- `gateway.py`
- docs
- tests

### Acceptance Criteria

- operator can inspect the full supervised recursive-improvement pipeline end to end

## Recommended Sequence

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6

Reason:

- correctness before workflow
- workflow before broader cognition reuse
- operational truth maintenance after the system semantics are stabilized
- exact worker launch and review semantics before agent-side orchestration heuristics

## Immediate Scope Boundary

Do not add another new cognition loop in this package.

First make self-improvement:

- correct
- bounded
- inspectable
- teachable
