# Tool Registry and Invocation Contract

## 1. Purpose

Define a stable contract for how Drost tools are:

- declared,
- exposed to providers,
- invoked from model tool calls,
- traced and error-normalized.

This contract is modeled after Morpheus’s `BaseTool` + `ToolRegistry` pattern.

## 2. Core Interfaces

## 2.1 `BaseTool`

Each tool must provide:

- `name: str`
- `description: str`
- `parameters: dict[str, Any]` (JSON Schema)
- `execute(**kwargs) -> str`

Expected semantics:

- return plain text on success,
- return `"Error: ..."` on recoverable tool failure,
- avoid raising for expected user/data errors.

## 2.2 `ToolDefinition` (Provider-facing)

Use a provider-neutral dataclass:

- `name`
- `description`
- `input_schema`

Providers convert it as needed:

- OpenAI-compatible: function tools shape,
- Anthropic: `input_schema` tool blocks.

## 3. `ToolRegistry` API

Required methods:

- `register(tool: BaseTool) -> None`
- `unregister(name: str) -> None`
- `get(name: str) -> BaseTool | None`
- `names() -> list[str]`
- `to_definitions() -> list[ToolDefinition]`
- `dispatch(name: str, params: dict[str, Any]) -> str`

Dispatch requirements:

1. Unknown tool returns `Error: Unknown tool '...'`.
2. Drop `None` values before passing kwargs to preserve defaults.
3. Catch unexpected exceptions and return `Error executing <tool>: <msg>`.

This behavior mirrors Morpheus `ToolRegistry.dispatch(...)` and keeps loop robust under model mistakes.

## 4. Tool Lifecycle Per Turn

1. Build active tool definitions from registry.
2. Pass definitions into provider chat call.
3. Provider yields `ToolCall` events.
4. Loop executes each call via registry dispatch.
5. Loop appends `Message(role=TOOL, tool_results=[...])`.
6. Next iteration continues with expanded message history.

## 5. Initial Tool Specifications

## 5.1 `memory_search`

Input:

- `query: string`
- `limit: integer` (optional)

Output:

- ranked snippets from SQLite memory search
- compact summary format with `memory_chunk_id`, `role`, `session_key`, snippet preview

## 5.2 `memory_get`

Input:

- `chunk_id: integer`

Output:

- full stored memory chunk text and metadata

## 5.3 `session_status`

Input:

- `chat_id: integer` (optional; defaults current turn chat context)

Output:

- active session id,
- session key,
- message count,
- latest sessions summary.

## 5.4 `file_read`

Input:

- `path: string`
- `offset: integer` (optional)
- `limit: integer` (optional)

Output:

- file contents or paged slice,
- explicit continuation hints for large files.

## 5.5 `file_write`

Input:

- `path: string`
- `content: string`

Output:

- success confirmation or explicit `Error: ...`.

## 5.6 `shell_execute`

Input:

- `command: string`
- `workdir: string` (optional)
- `timeout_seconds: number` (optional)

Output:

- stdout/stderr summary with exit status,
- explicit timeout and process-launch errors.
- no command allowlist/blocklist filtering in v1.

## 5.7 `web_search`

Input:

- `query: string`
- `limit: integer` (optional)

Output:

- ranked web results summary for citation/fetch follow-up.

Backend and config (v1):

- provider: Exa only,
- key source: `EXA_API_KEY` from `.env`/environment,
- missing key behavior: explicit `Error: ...` tool result.

## 5.8 `web_fetch`

Input:

- `url: string`
- `max_chars: integer` (optional)

Output:

- fetched readable content summary and metadata.

## 6. Execution Permissions and Trust Boundaries

v1 stance:

- tools include read/write/exec/web capabilities from day one.
- filesystem tools are unrestricted by path.
- shell execution is unrestricted by command.
- no confirmation or sandbox layer is applied in tool dispatch.

Recommended output handling:

- wrap external-content tool outputs (`web_search`, `web_fetch`) as untrusted content to reduce prompt-injection effects (Morpheus pattern).
- redact secrets and truncate large outputs in traces.

## 7. Observability Contract

For each tool execution, collect:

- `run_id`
- `iteration`
- `tool_call_id`
- `tool_name`
- `args` (redacted if needed)
- `ok`
- `is_error`
- `duration_ms`
- `result_preview` (bounded chars)

Storage options:

- JSONL in `~/.drost/traces/`,
- or `tool_traces` table in SQLite.

## 8. Error Semantics

Tool errors should stay model-visible, not runtime-fatal:

- Tool failure -> `ToolResult(is_error=True, content="Error: ...")`
- Loop continues unless fatal runtime condition is triggered.

Fatal runtime candidates:

- repeated same error for same tool call signature beyond threshold,
- malformed provider tool call payload across repeated iterations,
- time budget exhaustion.
