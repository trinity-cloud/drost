# Drost Target Design (Agentic Loop)

## 1. Objectives

Upgrade Drost from single-pass response generation to iterative tool-enabled execution while preserving current stability and simplicity.

Target properties:

- deterministic tool invocation lifecycle,
- provider-agnostic loop core,
- no regression to Telegram/session/memory persistence,
- minimal surface area compared with reference implementation,
- unrestricted tool execution (filesystem + shell) with no confirmation/sandbox gate in v1,
- clean extension points for future multi-loop orchestration (Gen 3).

## 2. Current vs Target

### Current (Drost)

- `AgentRuntime.respond(...)` performs:
  - memory retrieval,
  - single provider stream,
  - response persistence.
- no model-visible tools are registered or passed to providers.
- no assistant->tool->assistant iteration.

Reference:

- `drost/agent.py` lines ~73-156

### Target (Drost)

- `AgentRuntime.respond(...)` becomes:
  1. Build tool registry and tool definitions.
  2. Build system prompt via prompt assembly (`SOUL.md` + workspace context + memory block).
  3. Build initial message list with context-budgeted history.
  4. Run iterative loop via `LoopRunner` interface.
  5. Execute tool calls through registry.
  6. Feed tool results back into provider.
  7. Finalize assistant response and persist transcript/memory.

## 3. Proposed Runtime Architecture

## 3.1 New Modules

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
- `drost/agent_loop.py` (default runner implementation)

## 3.2 Existing Modules to Update

- `drost/agent.py`: delegate loop execution to new agent-run module.
- `drost/providers/openai_compatible.py`: enable tool definitions in request payload and parse tool calls from stream.
- `drost/providers/anthropic_provider.py`: add tool conversion + tool-use parsing in stream.
- `drost/channels/telegram.py`: edit one in-flight "working" message for progress updates.
- `drost/gateway.py`: optional run/usage metadata endpoints, no routing break.
- `drost/config.py`: add loop and tools config knobs.

## 4. Execution Responsibilities

### `AgentRuntime`

- session lock orchestration,
- session/history retrieval,
- base system prompt composition,
- final persistence (messages + memory),
- high-level error handling.

### `AgentLoopRunner`

- provider interaction loop,
- usage aggregation,
- tool execution integration,
- loop guardrails and termination semantics.

### `LoopRunner` (Interface)

- stable contract for any loop strategy:
  - `run_turn(...) -> AsyncIterator[AgentEvent]`
- initial implementation:
  - `DefaultSingleLoopRunner` (reference implementation-style iterative loop)
- future implementation:
  - `LoopManager` for multi-loop/mind-state orchestration without replacing `AgentRuntime`.

### `ToolRegistry`

- runtime tool instance ownership,
- conversion to provider tool definitions,
- dispatch and argument normalization.

## 5. Data Contracts

## 5.1 Tool Definition (Model Facing)

Must be provider-neutral:

- `name: str`
- `description: str`
- `input_schema: dict[str, Any]`

This mirrors reference implementation and aligns with existing provider abstractions already present in Drost.

## 5.2 Tool Result (Model Facing Feedback)

- `tool_call_id`
- `content`
- `is_error`

This already exists in `drost/providers/base.py` and should be actively used by the loop.

## 6. Initial Tool Surface for Drost v1

Locked built-ins for v1:

- `memory_search`
- `memory_get`
- `session_status`
- `file_read`
- `file_write`
- `shell_execute`
- `web_search`
- `web_fetch`
- `web_search` implementation in v1 uses Exa and reads `EXA_API_KEY` from `.env`/environment.

Rationale:

- Minimum viable autonomous capability for OSS adoption.
- Preserves memory/session introspection while adding practical action tools.
- Aligns with reference implementation learnings on real agent usefulness.

## 7. Prompt Assembly Design

Prompt assembly order for each run:

1. Base runtime instructions.
2. `SOUL.md` identity/personality block.
3. Additional workspace context blocks (docs/task files as configured).
4. Memory context block (retrieved snippets).
5. Optional dynamic run hints (provider/tool availability).

Default context budget target (soft defaults, configurable):

- `96K` total
- `24K` system prompt budget
- `24K` conversation history budget
- `24K` memory budget
- `24K` reserve

These are planning defaults, not hard minimums or maximums.

## 7.1 Conversation History Management

Default per-turn behavior:

- apply deterministic history trimming first (oldest-first) to fit budget,
- do not run summarization on every turn.

Compaction-style summarization behavior:

- trigger only when history crosses a configured threshold (target: ~70% of history budget),
- summarize older messages and keep recent messages verbatim (target: last 10-14 messages),
- inject summary context as synthetic carry-forward context,
- if summarization fails, continue with deterministic truncation (no turn failure).

This mirrors reference implementation compaction philosophy while keeping v1 latency/cost predictable.

## 8. Execution Permissions

v1 execution stance:

- `file_read`/`file_write` can access any path on the host filesystem.
- `shell_execute` can run arbitrary commands with optional caller-specified `workdir`.
- no confirmation modes, allowlists, blocklists, or sandbox constraints in the loop/tool layer.

## 9. Guardrails

Hard requirements for v1:

- max iterations cap (`agent_max_iterations`, default 8-12),
- max tool calls per run cap,
- tool timeout budget,
- run timeout budget,
- normalized tool errors returned to model as content, not raised blindly,
- graceful completion message on limit trips.

Optional v1.1:

- stuck-loop fingerprint detection (reference implementation-style repeated tool signature/output),
- dynamic disabling of repeatedly failing tools during a run.

## 10. Telegram UX for Long Runs

Telegram channel behavior during long tool-using runs:

1. Send one immediate "working" message.
2. Edit that same message with progress/status updates (tool start/end, phase transitions).
3. Replace with final answer on completion.

This avoids message spam and gives user feedback during 30s+ executions.

## 11. Non-Goals for This Milestone

- plugin runtime/tool factories,
- multi-profile runtime boot system.

These can be introduced later if Drost needs reference implementation-level operational complexity.
