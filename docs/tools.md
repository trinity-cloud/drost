# Built-In Tools

Drost ships with 14 tools that the agent can call during its iterative loop. Tools are registered per-turn and dispatched asynchronously with configurable timeouts.

## Memory Tools

### `memory_search`

Search long-term memory using natural language queries.

Performs vector similarity search (via embeddings) combined with keyword matching across all indexed memory sources: transcripts, daily memory, entity facts, summaries, and continuity records.

**Parameters:**
- `query` (string, required) — natural language search query
- `limit` (integer, optional) — max results to return (default: 6)

### `memory_get`

Retrieve a specific memory file or entity record by path.

Use this after `memory_search` returns a relevant result to read the full content of a memory file.

**Parameters:**
- `path` (string, required) — path to the memory file relative to the workspace

## Session Tools

### `session_status`

Get information about the current session and runtime state.

Returns the active session ID, message count, provider, workspace paths, and other runtime metadata.

**Parameters:** None required.

## Follow-Up Tools

### `followup_status`

List outstanding follow-ups for the current chat.

Returns follow-ups with their status, priority, due dates, and content.

**Parameters:**
- `status` (string, optional) — filter by status (pending/surfaced/completed/dismissed/expired)

### `followup_update`

Update the status of a follow-up.

Use this to mark follow-ups as completed, dismissed, or snoozed when the user resolves or postpones them.

**Parameters:**
- `id` (string, required) — follow-up ID
- `action` (string, required) — one of: `complete`, `dismiss`, `snooze`
- `notes` (string, optional) — additional context
- `snooze_until` (string, optional) — ISO-8601 datetime for snooze

## Deployer Tools

### `deployer_status`

Get the current deployer state including child process status, active commit, and recent events.

**Parameters:** None required.

### `deployer_request`

Submit a request to the deployer control plane.

Supports `restart`, `deploy`, and `rollback` actions through the file-backed request queue.

**Parameters:**
- `action` (string, required) — one of: `restart`, `deploy`, `rollback`
- `reason` (string, optional) — reason for the action
- `commit` (string, optional) — target commit for deploy actions

## Worker Tools

### `worker_status`

Inspect supervised Codex / Claude worker jobs without polling tmux manually.

Use this to list the current worker board or inspect one job in detail, including its last visible output and recommended next action.

**Parameters:**
- `job_id` (string, optional) — specific worker job id to inspect
- `include_task_spec` (boolean, optional) — include the canonical task spec for one job
- `limit` (integer, optional) — max jobs to include in the board view

### `worker_request`

Launch and manage supervised Codex / Claude worker jobs through durable job state.

Use this instead of `shell_execute` for worker launches, review decisions, retries, and stops.

**Parameters:**
- `action` (string, required) — one of: `launch`, `review_accept`, `review_reject`, `retry`, `stop`
- `job_id` (string, optional) — required for non-launch actions
- `worker_kind` (string, optional) — `codex` or `claude` for launch
- `prompt` (string, optional) — canonical task spec for launch
- `repo_root` (string, optional) — repo root override for launch
- `requested_mode` (string, optional) — `inspect`, `implement`, or `review`
- `write_scope` (string, optional) — write scope such as `repo` or `none`
- `requested_outputs` (array[string], optional) — outputs to inspect after launch
- `requested_tests` (array[string], optional) — tests the worker should help satisfy
- `requested_by` (string, optional) — requester identity
- `reviewer` (string, optional) — reviewer identity for review actions
- `notes` (string, optional) — review notes or stop context
- `reason` (string, optional) — retry or stop reason

## File Tools

### `file_read`

Read the contents of a file from the filesystem.

**Parameters:**
- `path` (string, required) — absolute or workspace-relative file path
- `line_start` (integer, optional) — start reading from this line
- `line_end` (integer, optional) — stop reading at this line

### `file_write`

Write content to a file on the filesystem.

**Parameters:**
- `path` (string, required) — absolute or workspace-relative file path
- `content` (string, required) — content to write

## Shell Tools

### `shell_execute`

Execute a shell command and return its output.

**Parameters:**
- `command` (string, required) — the shell command to run
- `timeout_seconds` (number, optional) — execution timeout

## Web Tools

### `web_search`

Search the web using the Exa API.

Requires `EXA_API_KEY` to be configured.

**Parameters:**
- `query` (string, required) — search query
- `num_results` (integer, optional) — max results (default: 5)

### `web_fetch`

Fetch the content of a web page and extract its text.

Uses httpx + BeautifulSoup for HTML parsing.

**Parameters:**
- `url` (string, required) — the URL to fetch
- `max_chars` (integer, optional) — max characters to return

## Loop Control Tools (Internal)

These tools are used internally by the agent loop and are not directly callable. They manage the structured execution contract:

- **`loop_checklist_patch`** — Add, update, remove, or clear checklist items during a run.
- **`loop_finish`** — Mark the run complete with a final response and completion check.
- **`loop_blocked`** — Stop the run when blocked, with a reason and optional user ask.

## Adding Custom Tools

To add a new tool:

1. Create a new file in `drost/tools/` implementing `BaseTool`.
2. Implement `name`, `description`, `parameters` (JSON Schema), and `async execute()`.
3. Register it in `drost/tools/__init__.py` inside `build_default_registry()`.

```python
from drost.tools.base import BaseTool

class MyTool(BaseTool):
    @property
    def name(self) -> str:
        return "my_tool"

    @property
    def description(self) -> str:
        return "Does something useful."

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "The input"},
            },
            "required": ["input"],
        }

    async def execute(self, *, input: str) -> str:
        return f"Result: {input}"
```
