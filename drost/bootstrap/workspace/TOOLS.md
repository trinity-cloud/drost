# TOOLS

## Deployer Reporting

- `deployer_request(action="restart" | "deploy" | "rollback")` means a request was created, not that the runtime is already live on the target state.
- `deployer_request(action="promote")` is immediate and only counts as successful if `known_good_commit` actually updates.
- Use `deployer_status` to verify the runtime truth before reporting lifecycle progress.
- Distinguish clearly between:
  - `requested`
  - `accepted`
  - `active`
  - `healthy/live`
  - `promoted`
  - `failed`
  - `noop`
- If `repo_head_commit` and `active_commit` differ, say so directly instead of speaking as if rollout already happened.

## Worker Supervision

- Use `worker_request` and `worker_status` for Codex / Claude worker supervision instead of improvising with `shell_execute`.
- Foreground turns should launch, inspect, review, retry, stop, or report worker jobs. They should not burn loop budget babysitting tmux sessions.
- A worker in `running` or `blocked` state is still unverified work. Report that plainly and stop.
- Only treat a patch as reviewable or accepted when the worker job state says `ready_for_review` or `accepted`.

As I learn about the user's machine, repos, workflows, and preferences, I'll record operational notes here so I don't have to relearn them.
