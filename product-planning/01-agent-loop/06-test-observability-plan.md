# Test and Observability Plan

## 1. Test Matrix

## 1.1 Unit Tests

Tool primitives:

- registry register/unregister/names behaviors,
- `to_definitions()` correctness,
- dispatch unknown tool and exception paths,
- `None` argument stripping behavior.

Built-in tools:

- `memory_search` query with hits/no hits,
- `memory_get` existing/non-existing chunk,
- `session_status` returns expected active session context,
- `file_read` paging + path handling,
- `file_write` success/failure cases,
- `shell_execute` timeout + exit-status handling,
- `web_search` (Exa) parse and formatting behavior,
- `web_fetch` fetch and truncation behavior.
- `web_search` missing `EXA_API_KEY` returns explicit tool error.

Loop runner:

- no-tool completion on first iteration,
- single tool call then completion,
- multiple tool-call iterations,
- max-iteration limit stop,
- tool exception path produces `is_error=True`,
- context budget enforcement behavior.

Prompt assembly:

- `SOUL.md` loading behavior,
- additional workspace context inclusion,
- system/history/memory budget application using the default 96K target split,
- deterministic truncation behavior,
- threshold-triggered compaction summarization behavior,
- summarization failure fallback to truncation.

Provider parsers:

- OpenAI stream with function call events -> `tool_call` emitted,
- Anthropic stream with `tool_use` block -> `tool_call` emitted,
- plain text stream remains unchanged.

## 1.2 Integration Tests

End-to-end gateway test (mock provider + real SQLite store):

1. create message that triggers tool call,
2. verify tool dispatch executed,
3. verify assistant final text persisted,
4. verify session history includes assistant and tool-cycle outcome.

Telegram integration test (mock bot adapter):

- command handling unaffected by loop changes,
- normal user text receives reply when loop path executes,
- long runs update one in-flight "working" message instead of emitting many status messages.

## 1.3 Regression Tests

Preserve existing behavior:

- provider selection endpoint,
- session management endpoints,
- memory status/search endpoints,
- single final assistant answer semantics.

## 2. Failure Injection Tests

Provider failures:

- stream raises exception before first delta,
- stream raises exception after partial deltas.

Tool failures:

- unknown tool name from model,
- malformed arguments,
- timeout in tool execution,
- web provider outages,
- command execution non-zero exit status.

Loop pathologies:

- repeated identical tool call chain,
- runaway iteration until limit stop.

## 3. Observability Requirements

## 3.1 Structured Logging

Per run:

- `run_id`,
- `provider`,
- `model`,
- `chat_id`,
- `session_key`,
- `iterations`,
- `tool_calls`,
- `duration_ms`,
- `input_tokens`,
- `output_tokens`,
- `context_budget_total`,
- `context_budget_system`,
- `context_budget_history`,
- `context_budget_memory`,
- `status` (`complete|error|limit_stop`).

Per tool call:

- `run_id`,
- `iteration`,
- `tool_name`,
- `tool_call_id`,
- `duration_ms`,
- `is_error`.

## 3.2 Trace Persistence (Optional but Recommended)

Option A:

- JSONL trace files under `~/.drost/traces/`.

Option B:

- SQLite `tool_traces` table:
  - `id`, `run_id`, `iteration`, `tool_name`, `tool_call_id`, `args_json`, `result_preview`, `is_error`, `duration_ms`, `created_at`.

## 3.3 Metrics (Lightweight)

Counters:

- `agent_runs_total`
- `agent_runs_error_total`
- `agent_runs_limit_stop_total`
- `tool_calls_total`
- `tool_calls_error_total`

Histograms:

- `agent_run_duration_ms`
- `tool_duration_ms`

## 4. CI Gate Proposal

Minimum gate:

1. `uv run pytest`
2. lint/type-check if configured
3. integration tests for tool-loop path (mocked provider stream)

Release gate:

1. cross-provider parser tests pass,
2. loop guardrail tests pass,
3. no regression in session/telegram command tests.

## 5. Runtime Debug Checklist

When a run misbehaves:

1. Confirm provider emitted tool calls in parsed stream.
2. Confirm tool exists in `ToolRegistry.names()`.
3. Confirm tool arguments were normalized (no `None` issue).
4. Confirm tool results appended as `MessageRole.TOOL`.
5. Confirm loop iteration count and limit-stop decisions from logs.
