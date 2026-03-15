# Supervised External Worker Model

## Goal

Make Codex and Claude Code first-class supervised workers, not improvised shell sessions.

## Problem

The current worker workflow is real but fragile.

Observed issues:

- interactive tmux sessions with weak visibility
- worker process running without useful reviewable output
- macOS approval/Gatekeeper issues for updated binaries
- auto-update hazards
- loop budget spent polling worker state in the foreground
- supervisor reporting progress before verifying artifacts

## Target Model

### Roles

#### Drost

Acts as:

- planner
- worker launcher
- reviewer
- validator
- deploy requester
- reporter

#### External Worker

Acts as:

- bounded implementation engine
- no authority to self-report completion as truth
- outputs must be verified by Drost

## Core Design Decision

The default worker path should be non-interactive and artifact-driven.

That means:

- prefer machine-readable stdout streams over interactive terminal sessions
- prefer durable task spec files over inline shell prompts
- prefer job records and event logs over "check tmux and see what happened"

`tmux` still matters, but as a transport and attachment surface.
It should not be the primary source of truth.

## Worker Contract

Each worker job should have:

- task spec file
- expected output location
- log file
- bounded repo scope
- explicit stop condition
- expected test commands

Possible files under `~/.drost/state/workers/`:

- `jobs/<job_id>.json`
- `jobs/<job_id>.prompt.md`
- `jobs/<job_id>.stdout.jsonl`
- `jobs/<job_id>.stderr.log`
- `jobs/<job_id>.last_message.txt`
- `jobs/<job_id>.review.json`
- `jobs/<job_id>.artifacts.json`

## Required Fields

- `worker_kind`: `codex` or `claude`
- `binary_path`
- `session_name`
- `task_spec_path`
- `log_path`
- `repo_root`
- `requested_outputs`
- `requested_tests`
- `status`
- `last_visible_output_at`
- `blocked_reason`
- `stdout_log_path`
- `stderr_log_path`
- `last_message_path`
- `task_hash`
- `requested_mode`: `inspect`, `implement`, `review`
- `write_scope`
- `launch_command`
- `exit_code`
- `started_at`
- `completed_at`

## Provider-By-Provider Workflow Breakdown

### Codex Workflow

Codex should be the default worker when Drost wants:

- direct repository implementation
- strong machine-readable event output
- bounded non-interactive execution

Recommended Codex supervision flow:

1. Drost writes `jobs/<job_id>.prompt.md`
2. Drost launches `codex exec` in non-interactive mode
3. Codex writes JSONL events to `stdout.jsonl`
4. Drost reads event output and `last_message.txt`
5. Drost inspects git diff and test results
6. Drost accepts, rejects, or asks for another bounded pass

Codex strengths in this model:

- native non-interactive mode
- machine-readable stdout with `--json`
- clean working-root control with `--cd`

Codex-specific failure modes to plan for:

- macOS approval/Gatekeeper breakage after updates
- auth drift under `~/.codex/auth.json`
- large event streams that need summarization instead of full replay

### Claude Code Workflow

Claude Code should be the default worker when Drost wants:

- a second independent implementation pass
- stronger review-style reasoning
- a supervised alternative when Codex is blocked or unhealthy

Recommended Claude supervision flow:

1. Drost writes `jobs/<job_id>.prompt.md`
2. Drost launches `claude --print --output-format stream-json`
3. Claude writes streaming JSON events to `stdout.jsonl`
4. Drost reads the event stream and terminal result
5. Drost inspects git diff and test results
6. Drost accepts, rejects, or launches a follow-up bounded pass

Claude strengths in this model:

- strong structured non-interactive print mode
- explicit permission mode control
- useful fallback when Codex is unavailable or blocked

Claude-specific failure modes to plan for:

- update drift in the local binary
- permission-mode mismatch
- tool-availability mismatch if launch flags drift from Drost's expectations

## Exact CLI Launch Commands

These should be treated as the initial canonical launch commands for the current machine.

They can later become config-driven, but the first implementation should be explicit and testable.

### Codex Launch Command

Binary on this machine:

- `/opt/homebrew/bin/codex`

Recommended launch command:

```bash
tmux new-session -d -s "drost:codex:${JOB_ID}" \
  "cd '${REPO_ROOT}' && cat '${TASK_SPEC_PATH}' | /opt/homebrew/bin/codex exec \
    --cd '${REPO_ROOT}' \
    --dangerously-bypass-approvals-and-sandbox \
    --json \
    -o '${LAST_MESSAGE_PATH}' \
    > '${STDOUT_LOG_PATH}' 2> '${STDERR_LOG_PATH}'"
```

Why this shape:

- `codex exec` gives bounded non-interactive execution
- `--json` creates a durable machine-readable event log
- `-o` captures the final answer separately from the event stream
- `tmux` keeps the worker attachable without making tmux the source of truth

### Claude Code Launch Command

Binary on this machine:

- `/Users/migel/.local/bin/claude`

Recommended launch command:

```bash
tmux new-session -d -s "drost:claude:${JOB_ID}" \
  "cd '${REPO_ROOT}' && cat '${TASK_SPEC_PATH}' | /Users/migel/.local/bin/claude \
    --print \
    --output-format stream-json \
    --permission-mode bypassPermissions \
    --dangerously-skip-permissions \
    --add-dir '${REPO_ROOT}' \
    > '${STDOUT_LOG_PATH}' 2> '${STDERR_LOG_PATH}'"
```

Why this shape:

- `--print` makes Claude bounded and scriptable
- `--output-format stream-json` gives a durable event stream
- `--permission-mode bypassPermissions` plus `--dangerously-skip-permissions` matches the trusted local runtime model already used by Drost
- `--add-dir` keeps file access aligned with the repo root

## Tmux And Session Naming Conventions

The naming scheme should be final and deterministic from the start.

### Job ID

Recommended format:

- `w_<worker_kind>_<YYYYMMDDTHHMMSSZ>_<shortid>`

Examples:

- `w_codex_20260314T020511Z_6f42c1`
- `w_claude_20260314T021004Z_91b8ad`

### Tmux Session Name

Recommended format:

- `drost:<worker_kind>:<job_id>`

Examples:

- `drost:codex:w_codex_20260314T020511Z_6f42c1`
- `drost:claude:w_claude_20260314T021004Z_91b8ad`

### Tmux Rules

- exactly one tmux session per worker job
- tmux session name is stored in the job record
- if the tmux session disappears but the process is still alive, mark the job `detached`
- if the process exits and tmux remains, mark the job `completed` or `failed` based on exit code
- do not encode truth into pane text; all truth must come from job files and process state

## Worker Status Model

Statuses should be explicit and narrow:

- `created`
- `launching`
- `running`
- `blocked`
- `stalled`
- `ready_for_review`
- `accepted`
- `rejected`
- `failed`
- `abandoned`

Additional derived flags:

- `has_diff`
- `tests_requested`
- `tests_passed`
- `awaiting_operator_decision`
- `deploy_requested`
- `deploy_verified`

## Launch Rules

### Codex

- use `codex exec`, not the interactive default CLI
- pin the working root with `--cd`
- capture JSONL stdout separately from stderr
- persist launch environment and binary path in the job record
- detect common macOS approval blockage explicitly
- record whether Codex exited cleanly, stalled, or never emitted a first event

### Claude

- use `--print --output-format stream-json`, not an interactive TUI
- capture stdout and stderr separately
- persist the exact permission mode in the job record
- same bounded spec/logging model
- same no-trust-without-review model

## Review Rules

Drost must not claim success until it has verified:

1. diff exists and is relevant
2. diff matches requested scope
3. requested tests ran and passed
4. no obvious regressions from review
5. deployer state reflects real rollout progress

## Multi-Job Operator UX

The worker model is not complete without an operator surface for supervising more than one job.

### Required Operator Surface

Add a dedicated worker status surface:

- `GET /v1/workers/status`
- `GET /v1/workers/jobs/<job_id>`
- `POST /v1/workers/jobs/<job_id>/review`
- `POST /v1/workers/jobs/<job_id>/stop`
- `POST /v1/workers/jobs/<job_id>/retry`

### Worker Board Summary

The summary view should show one row per job with:

- `job_id`
- `worker_kind`
- `repo_root`
- `status`
- `started_at`
- `last_visible_output_at`
- `has_diff`
- `tests_passed`
- `blocked_reason`
- `session_name`
- `next_recommended_action`

### Job Detail View

The detail view should include:

- canonical task spec
- exact launch command
- stdout/stderr log paths
- final/last worker message
- diff summary
- requested tests and latest result
- review status
- deploy linkage if the patch has been rolled out

### Operator Actions

The first version only needs these actions:

- `launch`
- `inspect`
- `tail_logs`
- `review_accept`
- `review_reject`
- `retry`
- `stop`
- `abandon`
- `request_deploy`

### Concurrency Rules

- allow multiple worker jobs to exist
- allow at most one write-capable active worker per repo root at a time
- additional jobs for the same repo should queue in `created` or `blocked`
- review-only jobs may run concurrently if they do not mutate the repo

This is the key difference between a real supervision system and "a few tmux sessions".

## Acceptance Criteria

- worker jobs are durable and inspectable
- supervision survives interrupted foreground runs
- blocked workers are distinguishable from idle workers
- Drost can cleanly say what the worker did and what is still unverified
- Codex and Claude launch through explicit non-interactive commands
- tmux session naming is deterministic and operator-readable
- multiple jobs can be inspected without relying on terminal attachment
