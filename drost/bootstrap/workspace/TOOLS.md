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

As I learn about the user's machine, repos, workflows, and preferences, I'll record operational notes here so I don't have to relearn them.
