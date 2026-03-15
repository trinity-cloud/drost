# Execution Control And Run Discipline

## Problem

The latest conversation showed that Drost can reason well but still lose the run operationally.

Failure modes seen in practice:

- runs consumed 100 iterations without finishing
- shell tool calls hit 30-second timeouts during worker supervision
- turns were spent polling or babysitting tmux sessions
- work that should have become a background/supervision state became a foreground-loop burden

## Principle

Foreground user turns should not carry the full cost of long-running external work.

Instead:

- foreground turns should be planning/reporting/supervision steps
- long worker execution should move into bounded supervision jobs
- user-visible replies should reflect verified state transitions

## Target Model

### 1. Distinguish Four Work Modes

1. **Inspect**
- read state
- gather evidence
- no long waits

2. **Launch**
- start bounded external work
- write task spec
- record worker handle/session id/log path

3. **Review**
- inspect diff, logs, tests, state transitions
- accept or reject the work

4. **Report**
- tell the user what is actually true now

These should replace open-ended "stay inside the loop until the worker finishes" behavior.

### 2. Supervision Job State

Introduce explicit supervision-job state under `~/.drost/state/`.

Possible file:
- `state/worker-supervision.json`

Tracked fields:
- `job_id`
- `worker_kind`
- `transport` (`tmux`, later maybe others)
- `session_name`
- `log_path`
- `task_spec_path`
- `repo_root`
- `started_at`
- `last_checked_at`
- `status` (`launched`, `running`, `blocked`, `ready_for_review`, `accepted`, `rejected`, `abandoned`)
- `diff_summary`
- `tests_summary`
- `last_error`

### 3. Foreground Loop Budget Policy

Foreground runs should be able to say:

- worker launched
- worker still running
- worker blocked
- diff ready for review
- tests passed
- patch rejected

without trying to sit inside a tool loop until final completion.

### 4. Polling Policy

Polling should be bounded and sparse.

Bad pattern:
- repeated shell polling every few seconds within one user turn

Good pattern:
- at most a small number of checks per foreground turn
- if worker is still running, persist state and return
- continue on the next user turn or a background supervision loop

### 5. Timeouts

Current tool timeout and run timeout are too coarse for supervision work.

Need explicit distinctions between:

- short inspect commands
- worker launch commands
- worker review commands
- long-running worker execution that should not stay inside a synchronous shell tool call

## Build Direction

### Short Term

- add supervision job state
- add worker launch/result files
- restrict foreground turns to launch/review/report semantics

### Medium Term

- dedicated background supervision loop
- event emission on worker state changes

## Acceptance Criteria

- Drost stops burning full loop budgets on worker babysitting
- user turns can resume supervision cleanly after interruption
- worker execution is inspectable from durable state, not only tool history
