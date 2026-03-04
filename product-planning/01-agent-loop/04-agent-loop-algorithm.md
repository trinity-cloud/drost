# Agent Loop Algorithm and State Machine

## 1. Algorithm Overview

Target loop (Morpheus-derived):

1. Assemble prompt context (`SOUL.md` + workspace context + memory context) under budget.
2. Apply deterministic history trimming to fit budgets.
3. Optionally run compaction-style summarization only when history crosses threshold.
4. Add user message to conversation.
5. Call provider streaming API with tools + system prompt.
6. Collect assistant text deltas and tool call events.
7. Append assistant message.
8. If tool calls exist:
9. Execute tool calls (with timeout policy).
10. Append tool result message.
11. Continue next iteration.
12. If no tool calls:
13. Complete and return final assistant text.
14. If iteration cap reached:
15. return iteration-limit completion text.

## 1.1 Runner Interface

Define a swappable interface now:

```python
class LoopRunner(Protocol):
    async def run_turn(self, ctx: TurnContext) -> AsyncIterator[AgentEvent]: ...
```

Initial implementation:

- `DefaultSingleLoopRunner` (the algorithm in this document).

Future:

- `LoopManager` can orchestrate multiple loop runners without changing callers.

## 2. Proposed Pseudocode

```python
async def run_loop(messages, system, tools, tool_executor, max_iterations):
    total_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    total_tool_calls = 0
    last_tool_error = None

    for iteration in range(max_iterations):
        full_content = ""
        tool_calls = []

        async for delta in provider.chat_stream(messages, system=system, tools=tools):
            if delta.usage:
                total_usage = merge_usage(total_usage, delta.usage)
                yield UsageEvent(total_usage)
            if delta.content:
                full_content += delta.content
                yield TextDeltaEvent(delta.content)
            if delta.tool_call:
                tool_calls.append(delta.tool_call)

        messages.append(
            Message(role=ASSISTANT, content=full_content or None, tool_calls=tool_calls)
        )

        if not tool_calls:
            yield CompleteEvent(total_usage, total_tool_calls)
            return

        tool_results = []
        for tc in tool_calls:
            total_tool_calls += 1
            yield ToolUseEvent(tc.name, tc.arguments)
            try:
                raw = await tool_executor(tc.name, tc.arguments)
                is_error = starts_with_error(raw)
                if is_error:
                    last_tool_error = raw
                tool_results.append(ToolResult(tc.id, normalize(raw), is_error=is_error))
            except Exception as exc:
                last_tool_error = str(exc)
                tool_results.append(ToolResult(tc.id, f"Error: {exc}", is_error=True))

        messages.append(Message(role=TOOL, tool_results=tool_results))

    yield TextDeltaEvent(build_iteration_limit_warning(max_iterations, last_tool_error))
    yield CompleteEvent(total_usage, total_tool_calls)
```

## 3. State Machine

States:

- `INIT`
- `LLM_STREAMING`
- `TOOL_EXECUTION`
- `COMPLETE`
- `ERROR`
- `LIMIT_STOP`

Transitions:

1. `INIT -> LLM_STREAMING` on run start.
2. `LLM_STREAMING -> TOOL_EXECUTION` if at least one tool call emitted.
3. `LLM_STREAMING -> COMPLETE` if no tool calls and stream ends normally.
4. `TOOL_EXECUTION -> LLM_STREAMING` after appending tool results.
5. `LLM_STREAMING -> ERROR` on provider fatal exception.
6. `TOOL_EXECUTION -> ERROR` on unrecoverable execution exception policy.
7. `LLM_STREAMING/TOOL_EXECUTION -> LIMIT_STOP` on iteration/tool/time budget.
8. `ERROR/LIMIT_STOP -> COMPLETE` after terminal message emission.

## 4. Streaming Event Model

Recommended event types:

- `text_delta`
- `tool_use`
- `run_status` (for Telegram progress-message edits)
- `usage`
- `error`
- `complete`

This mirrors Morpheus `AgentEvent` and allows future UI/transport upgrades with no loop rewrite.

Telegram mapping:

- emit one initial `run_status` event to create a "working" message,
- emit subsequent `run_status` events to edit that same message,
- emit `complete` to replace it with final response text.

## 5. Guardrails

Required:

- `max_iterations` cap.
- `max_tool_calls_per_run` cap.
- `per_tool_timeout_seconds`.
- `max_run_duration_seconds`.

## 5.1 Context Budgeting

Default budget target (soft defaults, configurable):

- `96K` total context budget
- `24K` system prompt budget
- `24K` history budget
- `24K` memory budget
- `24K` reserve

Budget values are defaults, not hard min/max bounds. Runtime may rebalance as needed.

History handling policy:

- default path: deterministic truncation (oldest-first),
- compaction path: threshold-triggered summary of older turns, keeping recent turns verbatim,
- summary failure path: fall back to deterministic truncation (never fail the turn).

Recommended:

- repeated-call detector:
  - fingerprint `(tool_name, sorted(args.keys()), stable arg hash)`,
  - stop if same fingerprint repeats `N` times with identical outputs.

## 6. Ordering Policy

v1 execution policy:

- execute tool calls in provider order, sequentially.

Reasons:

- deterministic transcript,
- easier debugging,
- simpler SQLite interaction and testability.

Potential v2:

- parallel execution for explicitly side-effect-free tools.

## 7. Failure Strategy

Recoverable:

- unknown tool,
- bad parameters,
- local data miss.

Handling:

- return `Error: ...` tool result and continue loop.

Unrecoverable:

- provider stream crash with no partial recoverability,
- total run timeout exceeded.

Handling:

- emit user-visible error chunk,
- close run cleanly,
- persist partial transcript when possible.
