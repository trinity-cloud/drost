# Implementation Workplan

## Build Objective

Ship compounding memory without bloating Drost into reference implementation.

The work should preserve the current architecture:

- FastAPI gateway stays simple
- Telegram stays the only channel
- SQLite remains the index
- Markdown remains the durable memory substrate

## Phase 1: Canonical Memory File Model

### Build

- formalize `memory/daily` and `memory/entities` as first-class runtime directories
- add file helpers for daily notes and entity memory writes
- keep `MEMORY.md` as the curated top-level memory file
- add state directory for maintenance and continuity

### Code Touchpoints

- `drost/workspace_bootstrap.py`
- `drost/workspace_loader.py`
- `drost/config.py`
- new module: `drost/memory_files.py`

### Acceptance Criteria

- first-run and existing workspaces converge on the same directory layout
- helper APIs can read and append daily notes and entity facts deterministically
- file formats are documented and tested

## Phase 2: Unified Memory Index

### Build

- extend SQLite schema for multi-source memory rows
- index workspace memory files alongside transcripts
- keep provenance fields per row
- make reindexing deterministic and rebuildable
- switch the memory embedding backend to Gemini
- use `gemini-embedding-001` at full `3072` dimensions
- use `RETRIEVAL_DOCUMENT` for indexed chunks and `RETRIEVAL_QUERY` for live queries
- read `GEMINI_API_KEY` from `.env`
- pass `GEMINI_API_KEY` explicitly into the Gemini client instead of depending on alternate SDK env-var discovery

### Code Touchpoints

- `drost/storage/database.py`
- `drost/agent.py`
- `drost/embeddings.py`
- `drost/config.py`
- `pyproject.toml`
- possibly new module: `drost/storage/memory_indexer.py`
- tests under `tests/test_storage.py`

### Acceptance Criteria

- search results can come from either transcripts or workspace memory files
- returned results carry path and line references
- index can be rebuilt from disk without data loss of meaning
- embedding vectors are stored at `3072` dimensions
- Drost uses `GEMINI_API_KEY` as the only configured auth input for this embedding path

## Phase 3: Tool Contract Upgrade

### Build

- upgrade `memory_search` result shape
- upgrade `memory_get` to support path/line reads and transcript reads
- preserve backward compatibility for chunk-id lookup during transition

### Code Touchpoints

- `drost/tools/memory_search.py`
- `drost/tools/memory_get.py`
- `drost/tools/__init__.py`
- tests for tool outputs and path reads

### Acceptance Criteria

- the model can inspect exact memory file lines
- transcript evidence and memory-file evidence use the same retrieval language
- tool output is understandable from the transcript alone

## Phase 4: Maintenance Runner

### Build

- add background memory maintenance runner
- read new JSONL lines incrementally
- extract daily notes and entity facts
- write files and reindex touched sources

### Code Touchpoints

- new module: `drost/memory_maintenance.py`
- `drost/gateway.py`
- `drost/agent.py` only where hooks are needed
- `drost/storage/session_jsonl.py`
- tests with synthetic transcript fixtures

### Acceptance Criteria

- runner advances cursors correctly
- repeated runs do not duplicate identical facts aggressively
- new transcript material becomes searchable through memory files

## Phase 5: Weekly Synthesis

### Build

- generate `summary.md` for entities from `items.md`
- maintain synthesis state
- prefer summaries in ambient capsules

### Code Touchpoints

- `drost/memory_maintenance.py`
- `drost/workspace_loader.py`
- `drost/prompt_assembly.py`

### Acceptance Criteria

- entity summaries stay current enough for prompt preload
- summary generation is bounded and does not rewrite unchanged entities every run

## Phase 6: Continuity Manager

### Build

- add `/new` session carryover manager
- summarize prior session into the new session in background
- inject a bounded continuity summary into the target session

### Code Touchpoints

- new module: `drost/sessions_continuity.py`
- `drost/agent.py`
- `drost/channels/telegram.py`
- `drost/gateway.py`

### Acceptance Criteria

- session transitions preserve concrete context
- carryover is factual and bounded
- failures degrade gracefully without breaking session creation

## Phase 7: Prompt-Time Memory Capsule

### Build

- build deterministic ambient memory capsule assembly from unified index
- use stronger memory-aware prompt sections
- make capsule budgeted and query-sensitive

### Code Touchpoints

- `drost/prompt_assembly.py`
- `drost/agent.py`
- possibly new module: `drost/memory_capsule.py`

### Acceptance Criteria

- recall-heavy turns perform better without extra tool calls
- trivial turns remain lightweight
- workspace files and memory capsule do not fight for prompt real estate blindly

## Recommended Sequence

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 6
6. Phase 5
7. Phase 7

Reason:

- memory needs a durable file substrate before compounding can work
- the index and tool contract must stabilize before automation writes into it
- continuity becomes more valuable once the index and maintenance exist
- summaries and capsules are best added after the raw memory flows are correct

## Rollout Strategy

Use feature flags for each major subsystem:

- `DROST_MEMORY_FILES_ENABLED`
- `DROST_MEMORY_INDEX_WORKSPACE_ENABLED`
- `DROST_MEMORY_MAINTENANCE_ENABLED`
- `DROST_MEMORY_CONTINUITY_ENABLED`
- `DROST_MEMORY_CAPSULE_ENABLED`

Default recommendation:

- ship file model and index first
- enable maintenance locally before default-on
- enable continuity after transcript source selection is stable
- enable ambient capsule last so ranking problems do not hide earlier defects

Embedding-specific rollout note:

- land the Gemini embedding switch together with the unified memory index migration
- do not keep the old `384`-dimension memory index shape once the new index is enabled
