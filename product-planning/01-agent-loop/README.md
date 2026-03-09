# Drost Agent Loop Planning Package

## Goal
Design and stage a production-style agentic loop for Drost that supports:

- provider-native tool calling (OpenAI Codex OAuth, Anthropic setup-token/API key, xAI OpenAI-compatible),
- a deterministic tool registry and dispatch layer,
- deterministic and observable iterative turns (`LLM -> tool(s) -> LLM ... -> final`),
- Telegram + FastAPI integration without breaking current runtime behavior,
- prompt assembly from `SOUL.md` + workspace context with explicit token budgeting.

## Scope of This Package
This planning package is implementation-focused and maps directly to Drost’s current codebase.

It includes:

1. North-star analysis from reference implementation internals.
2. Target Drost architecture for tool-enabled turns.
3. Tool creation and invocation contract.
4. Detailed loop algorithm/state machine.
5. Step-by-step implementation workplan with file-level changes.
6. Testing and observability requirements.
7. Risks and open decisions.

## Fixed Product Decisions (Locked)

- Phase 1 tool MVP includes:
  - `memory_search`
  - `memory_get`
  - `session_status`
  - `file_read`
  - `file_write`
  - `shell_execute`
  - `web_search`
  - `web_fetch`
- `web_search` backend in v1: Exa only, keyed by `EXA_API_KEY` from `.env`/environment.
- Tool execution permissions in v1: unrestricted filesystem read/write and unrestricted command execution.
- Prompt identity source: `SOUL.md` (with additional workspace context files).
- Telegram progress UX: edit a single "working" message during long runs.
- Default context budget target: `96K` total with:
  - `24K` system prompt budget
  - `24K` conversation history budget
  - `24K` memory budget
  - `24K` reserve
- Budget values above are defaults/targets, not hard minimums or maximums.
- History management default: deterministic truncation per turn.
- Summarization strategy: compaction-style summarization only when threshold is exceeded; fallback to truncation on summary failure.

## Document Map

1. [01-reference-loop-analysis.md](./01-reference-loop-analysis.md)
2. [02-drost-target-design.md](./02-drost-target-design.md)
3. [03-tool-registry-and-invocation.md](./03-tool-registry-and-invocation.md)
4. [04-agent-loop-algorithm.md](./04-agent-loop-algorithm.md)
5. [05-implementation-workplan.md](./05-implementation-workplan.md)
6. [06-test-observability-plan.md](./06-test-observability-plan.md)
7. [07-risks-open-questions.md](./07-risks-open-questions.md)

## Primary North-Star References (reference implementation)

- `reference-runtime/agent_run.py`
- `reference-runtime/agent.py`
- `reference-runtime/gateway/streaming_turn.py`
- `reference-runtime/gateway/streaming.py`
- `reference-runtime/tools/base.py`
- `reference-runtime/tools/registry.py`
- `reference-runtime/tools/__init__.py`
- `reference-runtime/tools/policy.py`
- `reference-runtime/providers/openai.py`
- `reference-runtime/providers/openai_streaming.py`
- `reference-runtime/providers/anthropic.py`
- `reference-runtime/orchestration/runtime.py`

## Current Drost Baseline

- Turn execution is single-pass text completion in `drost/agent.py` (no iterative tool loop).
- Provider interfaces already include `ToolCall`/`ToolResult` types in `drost/providers/base.py`, but they are unused.
- Telegram and gateway are stable and production-usable for single-instance polling/webhook.
- SQLite + sqlite-vec memory is available and can power memory tools immediately.

This package plans the next step: upgrading Drost from "single-shot chat runtime" to "tool-enabled agent runtime."
