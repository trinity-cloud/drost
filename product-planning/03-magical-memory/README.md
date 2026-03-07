# Magical Memory

## Goal

Turn Drost's current transcript recall into a compounding memory system that feels personal, continuous, and inspectable.

The target product effect is the Morpheus feel:

- the agent has a stable sense of self and user context
- important facts compound into durable workspace memory
- new sessions inherit the right carryover automatically
- recall-heavy questions surface the right context before the model starts guessing

This package assumes the recent workspace-loader/bootstrap work is already in place. It focuses on the next missing layer: serious memory.

## Why This Package Exists

Drost is already strong on:

- provider support
- tool use
- Telegram runtime
- dual JSONL transcripts
- SQLite + vector-backed recall over transcripts
- workspace-based personality scaffolding

The main gap is that Drost still remembers mostly like a search engine over prior chat. Morpheus feels stronger because memory compounds into durable files, gets summarized, and flows across sessions.

## Documents

- `01-current-state-and-gap.md`: exact gap between Drost today and Morpheus-grade memory behavior
- `02-canonical-memory-model.md`: on-disk file layout and source-of-truth rules
- `03-index-and-retrieval-contract.md`: SQLite index model, search contract, and retrieval behavior
- `04-maintenance-and-continuity.md`: extraction, synthesis, and `/new` carryover design
- `05-prompt-capsules-and-agent-behavior.md`: how magical recall should actually reach the model
- `06-implementation-workplan.md`: concrete build order with code touchpoints and acceptance criteria
- `07-test-observability-and-risks.md`: test plan, rollout instrumentation, and major failure modes

## Source Basis

This package is grounded in these Morpheus references:

- `/Users/migel/Morpheus/morpheus/workspace/loader.py`
- `/Users/migel/Morpheus/morpheus/workspace/prompt.py`
- `/Users/migel/Morpheus/morpheus/memory/maintenance.py`
- `/Users/migel/Morpheus/morpheus/sessions/continuity.py`
- `/Users/migel/Morpheus/sample-workspace/AGENTS.md`
- `/Users/migel/Morpheus/sample-workspace/BOOTSTRAP.md`
- `/Users/migel/Morpheus/sample-workspace/MEMORY.md`

And these Google Gemini references:

- `https://ai.google.dev/tutorials/embeddings_quickstart`
- `https://ai.google.dev/api/embeddings`
- `https://ai.google.dev/gemini-api/docs/migrate`

Current-state Drost references:

- `/Users/migel/drost/drost/workspace_loader.py`
- `/Users/migel/drost/drost/prompt_assembly.py`
- `/Users/migel/drost/drost/agent.py`
- `/Users/migel/drost/drost/storage/database.py`
- `/Users/migel/drost/drost/storage/session_jsonl.py`
- `/Users/migel/drost/drost/tools/memory_search.py`
- `/Users/migel/drost/drost/tools/memory_get.py`
- `/Users/migel/drost/drost/config.py`

## Bottom Line

The next serious Drost build should do six things:

1. Make Markdown files, not SQLite rows, the canonical durable memory substrate.
2. Index workspace memory files and transcripts together in SQLite.
3. Add incremental extraction from transcripts into `memory/daily` and `memory/entities`.
4. Add continuity summaries for session transitions.
5. Build deterministic prompt-time memory capsules.
6. Keep all of it inspectable and editable from disk.

## Embedding Decision

For the new memory system, Drost should standardize on Google's Gemini embeddings API:

- model: `gemini-embedding-001`
- auth: `GEMINI_API_KEY`
- output size: full default vector size, `3072`
- query mode: `RETRIEVAL_QUERY`
- indexed-memory mode: `RETRIEVAL_DOCUMENT`

We should not truncate vectors in this pass. The memory index should be built around the full 3072-dimensional output.

## Recommendation

Build this next as `Phase 2` of Drost's evolution. Do not add more tools first. The biggest product lift now comes from compounding memory and continuity.
