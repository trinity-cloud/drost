# Implementation Workplan

## 1. Delivery Strategy

Implement in eight phases (plus baseline) to keep runtime stable and testable.

## 2. Phase Plan

## Phase 0: Baseline Safety Net

Tasks:

- lock current behavior with tests around:
  - session switching,
  - memory retrieval,
  - provider fallback selection,
  - Telegram command handling.

Files:

- `tests/test_agent.py`
- `tests/test_gateway.py` (add if missing)
- `tests/test_telegram_channel.py` (add if missing)

Exit criteria:

- all baseline tests green before loop changes.

## Phase 1: Tool Primitives

Tasks:

- add `BaseTool`,
- add `ToolDefinition` (if not added to providers base),
- add `ToolRegistry`,
- add v1 MVP tool pack:
  - `memory_search`,
  - `memory_get`,
  - `session_status`,
  - `file_read`,
  - `file_write`,
  - `shell_execute`,
  - `web_search`,
  - `web_fetch`.
- implement `web_search` on Exa in v1, using `EXA_API_KEY` from `.env`/environment.

Files:

- `drost/tools/base.py`
- `drost/tools/registry.py`
- `drost/tools/memory_search.py`
- `drost/tools/memory_get.py`
- `drost/tools/session_status.py`
- `drost/tools/file_read.py`
- `drost/tools/file_write.py`
- `drost/tools/shell_execute.py`
- `drost/tools/web_search.py`
- `drost/tools/web_fetch.py`
- `drost/tools/__init__.py`
- `drost/config.py`

Exit criteria:

- registry converts to tool definitions correctly,
- dispatch handles unknown tools and `None` params predictably,
- unit tests for each built-in tool,
- missing `EXA_API_KEY` yields explicit non-fatal tool error.

## Phase 1.5: Prompt Assembly and Context Budgets

Tasks:

- add prompt assembly pipeline:
  - base runtime instructions,
  - `SOUL.md`,
  - additional workspace context files,
  - memory context.
- add context budget manager with soft default targets:
  - `96K total`,
  - `24K system`,
  - `24K history`,
  - `24K memory`,
  - `24K reserve`.
- ensure budget values are configurable and not hard min/max constraints.
- add history management policy:
  - default per-turn deterministic truncation (oldest-first),
  - compaction-style summarization only on threshold breach,
  - summary failure fallback to truncation.
- compaction trigger target: ~70% of history budget; preserve recent messages verbatim.

Files:

- `drost/prompt_assembly.py`
- `drost/context_budget.py`
- `drost/agent.py`
- `drost/config.py`

Exit criteria:

- assembled system prompt is deterministic and test-covered,
- history/memory truncation honors budget targets with stable behavior,
- compaction summarization is threshold-gated and not executed every turn.

## Phase 2: Provider Tool-Calling Plumbing

Tasks:

- OpenAI-compatible provider:
  - accept tool definitions in request payload,
  - parse function-call events into `StreamDelta.tool_call`.
- Anthropic provider:
  - map tool definitions to anthropic format,
  - parse streaming tool-use blocks.

Files:

- `drost/providers/openai_compatible.py`
- `drost/providers/anthropic_provider.py`
- `drost/providers/base.py` (only if dataclass additions needed)

Exit criteria:

- mocked provider streams can emit tool calls end-to-end,
- no regression for plain text-only turns.

## Phase 3: Agent Loop Runner

Tasks:

- add `LoopRunner` interface (`run_turn(...)` contract).
- add `DefaultSingleLoopRunner` with reference implementation-style iteration.
- integrate usage aggregation, tool call counting, and loop cap enforcement.
- keep return API compatible with existing `AgentRuntime.respond(...)`.

Files:

- `drost/loop_runner.py` (new)
- `drost/agent_loop.py` (new)
- `drost/agent.py` (integration)
- `drost/config.py` (new loop settings)

Recommended config keys:

- `agent_max_iterations` (default 10)
- `agent_max_tool_calls_per_run` (default 24)
- `agent_tool_timeout_seconds` (default 30)
- `agent_run_timeout_seconds` (default 180)
- `context_budget_total_tokens` (default 96_000 target)
- `context_budget_system_tokens` (default 24_000 target)
- `context_budget_history_tokens` (default 24_000 target)
- `context_budget_memory_tokens` (default 24_000 target)
- `context_budget_reserve_tokens` (default 24_000 target)
- `history_compaction_enabled` (default true)
- `history_compaction_trigger_ratio` (default 0.70 target)
- `history_compaction_keep_recent_messages` (default 12 target)
- `history_compaction_summary_max_tokens` (default 1500 target)

Exit criteria:

- multi-iteration tool loop works in tests,
- loop exits correctly on no-tools path and limit path.

## Phase 4: Gateway and Telegram Wiring

Tasks:

- expose loop metadata in optional API endpoint:
  - last run usage,
  - tool calls count,
  - run id.
- implement Telegram progressive updates by editing one in-flight "working" message.
- ensure Telegram path remains compatible with session commands and long messages.

Files:

- `drost/gateway.py`
- `drost/channels/telegram.py`

Exit criteria:

- no command regressions (`/new`, `/sessions`, `/use`, `/current`, `/reset`),
- normal text response behavior unchanged when no tools are called,
- long runs show visible progress without message spam.

## Phase 5: Observability and Tracing

Tasks:

- add per-run logs:
  - iteration count,
  - tools used,
  - duration,
  - token usage.
- add optional JSONL or SQLite trace persistence.

Files:

- `drost/agent_loop.py`
- `drost/storage/database.py` (if SQLite trace table chosen)

Exit criteria:

- each run has traceable execution lifecycle in logs/storage.

## Phase 6: Hardening and Edge Cases

Tasks:

- add stuck-loop detection for repeated identical tool calls.
- enforce per-tool timeout wrappers.
- improve user-facing termination messaging.

Files:

- `drost/agent_loop.py`
- `tests/test_agent_loop_guardrails.py`

Exit criteria:

- deterministic behavior under looping and failing-tool scenarios.
- unrestricted tool behavior is explicit and tested.

## Phase 7: Documentation and Release Readiness

Tasks:

- update README with tool loop architecture and configuration.
- document built-in tools and unrestricted execution semantics.
- add migration notes for existing users.

Files:

- `README.md`
- `docs/` (if introduced)

Exit criteria:

- docs align with shipped behavior and config defaults.

## 3. File-Level Delta Summary

Create:

- `drost/tools/base.py`
- `drost/tools/registry.py`
- `drost/tools/__init__.py`
- `drost/tools/memory_search.py`
- `drost/tools/memory_get.py`
- `drost/tools/session_status.py`
- `drost/tools/file_read.py`
- `drost/tools/file_write.py`
- `drost/tools/shell_execute.py`
- `drost/tools/web_search.py`
- `drost/tools/web_fetch.py`
- `drost/prompt_assembly.py`
- `drost/context_budget.py`
- `drost/loop_runner.py`
- `drost/agent_loop.py`
- `tests/test_tools_registry.py`
- `tests/test_agent_loop.py`
- `tests/test_provider_tool_parsing.py`
- `tests/test_prompt_assembly.py`
- `tests/test_context_budget.py`
- `tests/test_telegram_progress_updates.py`

Modify:

- `drost/agent.py`
- `drost/providers/openai_compatible.py`
- `drost/providers/anthropic_provider.py`
- `drost/providers/base.py` (if needed)
- `drost/config.py`
- `drost/gateway.py`
- `README.md`

## 4. Definition of Done

Done means:

1. Drost can complete a run requiring at least one tool call and return a coherent final answer.
2. Same run works against all configured providers that support tools in runtime config.
3. Loop guardrails prevent infinite iteration and fail predictably.
4. Prompt assembly includes `SOUL.md` + workspace context + budgeted memory/history.
5. Telegram long runs update one "working" message in place.
6. Existing non-tool chat path remains stable.
7. Tests cover success, tool errors, and termination guardrails.
