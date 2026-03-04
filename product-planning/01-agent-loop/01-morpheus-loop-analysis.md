# Morpheus North-Star Analysis

## 1. End-to-End Turn Flow

In Morpheus, a user turn passes through these layers:

1. Channel receives inbound user text.
2. `StreamingHandler.handle_streaming(...)` enqueues work into orchestration lanes.
3. `process_message_inner(...)` builds system prompt, tools, hooks, and executes `agent.run(...)`.
4. `AgentRunMixin.run(...)` performs iterative streaming LLM calls, executes tool calls, appends tool results, and repeats until no tools are requested or limits are hit.

Key references:

- `morpheus/gateway/streaming.py` lines ~305-336
- `morpheus/gateway/streaming_turn.py` lines ~22-347
- `morpheus/agent_run.py` lines ~99-407

## 2. How Tools Are Created

### 2.1 Tool Primitive Contract

Every tool extends `BaseTool`:

- `name`
- `description`
- `parameters` (JSON Schema)
- `execute(**kwargs) -> str`

Reference:

- `morpheus/tools/base.py` lines ~9-48

### 2.2 Registry Pattern

`ToolRegistry` is the central container:

- `register(tool)`
- `names()`
- `to_definitions()` for model-facing schemas
- `dispatch(name, params)` for runtime execution

Reference:

- `morpheus/tools/registry.py` lines ~12-107

Important behavior:

- `dispatch` strips `None` fields before `execute` call to preserve Python defaults (strict schema compatibility).
- Unknown tools return explicit `"Error: Unknown tool ..."` string (not exception explosion).

### 2.3 Tool Set Assembly

Tools are assembled during profile boot:

1. `register_all_tools(...)` wires core tools.
2. Additional tools are registered by dedicated boot helpers (subagents, cron, sessions, codex).
3. Plugin runtime may inject additional tool instances via factories.
4. `apply_tool_policy(...)` filters registry to allowed tools.

References:

- `morpheus/tools/__init__.py` lines ~101-275
- `morpheus/gateway/boot_mixins_profiles.py` lines ~55-190
- `morpheus/gateway/boot_profile_runtime.py` lines ~13-176
- `morpheus/tools/policy.py` lines ~151-209
- `morpheus/plugins/runtime.py` lines ~166-287

## 3. How Tools Are Invoked

Tool invocation happens inside a wrapper executor defined per turn in `process_message_inner(...)`:

1. Agent requests tool call(s).
2. `_tool_executor(name, params)` calls `tool_registry.dispatch(...)`.
3. Plugin hooks fire around tool execution (`tool.before`, `tool.after`, `tool.error`).
4. Evidence receipts and tool traces are emitted.

Reference:

- `morpheus/gateway/streaming_turn.py` lines ~261-315

Inside `AgentRunMixin.run(...)`, each tool call:

1. emits `AgentEvent(type="tool_use")`,
2. executes via `tool_executor`,
3. normalizes/wraps output,
4. creates `ToolResult` and appends it as a `tool` role message for next iteration.

Reference:

- `morpheus/agent_run.py` lines ~224-307

## 4. Agentic Loop Mechanics

Core loop behavior in `AgentRunMixin.run(...)`:

1. Convert inbound messages to provider message objects.
2. For each iteration up to `max_iterations`:
3. Stream provider output (`chat_stream`).
4. Accumulate text deltas and tool calls.
5. Append assistant message.
6. If tool calls exist:
7. Execute tool calls, append tool result message, continue loop.
8. If no tool calls:
9. Emit final usage + complete.

Reference:

- `morpheus/agent_run.py` lines ~109-384

Safety mechanisms:

- Hard loop cap (`max_iterations`).
- last-tool-error hint in termination message.
- process polling loop breaker for repeated `process` tool signatures/outputs.
- disable problematic tools dynamically on known fatal configuration errors.

Reference:

- `morpheus/agent_run.py` lines ~125-131, ~309-378, ~386-406

## 5. Provider-Level Tool Call Parsing

Morpheus keeps provider-specific parsing in provider adapters while exposing a normalized stream interface (`StreamDelta` with optional `tool_call`):

- OpenAI Responses API parsing from stream events and `response.completed`.
- Anthropic tool-use block parsing via streaming events.

References:

- `morpheus/providers/openai_streaming.py` lines ~215-410
- `morpheus/providers/openai.py` lines ~432-454
- `morpheus/providers/anthropic.py` lines ~281-389

## 6. Orchestration Around the Loop

Morpheus runs per-lane orchestration for concurrent sessions:

- submission queue policies (`collect`, `queue`, `interrupt`, `steer`, etc.),
- active run cancellation/replacement,
- durable lane queue state (optional),
- backpressure and message merging in collect mode.

References:

- `morpheus/gateway/streaming.py` lines ~82-87, ~305-337
- `morpheus/orchestration/runtime.py` lines ~70-167, ~422-492
- `morpheus/orchestration/runtime_internals.py` lines ~69-119

## 7. What to Reuse for Drost

Directly reusable design patterns:

- `BaseTool` + registry + `to_definitions()` contract.
- provider-normalized `StreamDelta` with tool calls.
- iterative loop shape from `AgentRunMixin.run(...)`.
- per-turn tool executor wrapper with tracing.
- `Error:` prefix semantics for non-fatal tool failures.

Patterns to simplify for Drost v1:

- no multi-profile boot complexity,
- no plugin runtime requirement initially,
- no route/model policy matrix at first (full built-in tool set enabled by default),
- no lane orchestration feature matrix initially; per-session lock is acceptable for first release.

Locked Drost v1 implication:

- keep Morpheus loop mechanics, but ship a practical initial tool pack:
  - memory (`memory_search`, `memory_get`),
  - session (`session_status`),
  - filesystem (`file_read`, `file_write`),
  - execution (`shell_execute`),
  - web (`web_search`, `web_fetch`).
