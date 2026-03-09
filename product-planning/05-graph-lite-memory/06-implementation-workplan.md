# Implementation Workplan

## Build Objective

Ship relationship-aware memory without adding a separate graph service or collapsing Drost into a sprawling memory platform.

## Phase 1: Canonical File Model

### Build

- add `aliases.md` and `relations.md` to the entity directory contract
- extend `MemoryFiles` with deterministic alias and relation write helpers
- document relation id format and duplicate suppression rules

### Code Touchpoints

- `drost/memory_files.py`
- `drost/workspace_bootstrap.py`
- tests under `tests/test_memory_files.py`

### Acceptance Criteria

- aliases and relations can be written deterministically
- duplicate suppression works for exact duplicates
- entity directories remain human-readable

## Phase 2: Derived Graph Index

### Build

- extend SQLite schema with `memory_entities`, `memory_entity_aliases`, and `memory_relations`
- extend workspace memory indexing to parse `aliases.md` and `relations.md`
- index relation text with Gemini embeddings using the existing `3072`-dimensional path

### Code Touchpoints

- `drost/storage/database.py`
- `drost/storage/memory_indexer.py`
- `drost/embeddings.py`
- tests under `tests/test_storage.py` and `tests/test_memory_indexer.py`

### Acceptance Criteria

- entity aliases are searchable and resolvable
- relation rows are indexed with provenance and confidence
- rebuild from disk is deterministic

## Phase 3: Maintenance Extraction Upgrade

### Build

- extend maintenance prompts to extract entities, aliases, and relations
- add deterministic entity-resolution pipeline
- write facts, aliases, and relations in one batch

### Code Touchpoints

- `drost/memory_maintenance.py`
- `drost/memory_files.py`
- possibly new module: `drost/entity_resolution.py`
- tests under `tests/test_memory_maintenance.py`

### Acceptance Criteria

- repeated mentions resolve to stable entities when evidence is strong
- low-confidence merges do not silently collapse distinct entities
- relationship extraction is bounded and resumable

## Phase 4: Summary And Continuity Upgrade

### Build

- make entity summary synthesis graph-aware
- let continuity generation read graph summaries and changed relations
- keep continuity bounded and factual

### Code Touchpoints

- `drost/memory_maintenance.py`
- `drost/session_continuity.py`
- `drost/workspace_loader.py`
- tests under `tests/test_memory_maintenance.py` and `tests/test_session_continuity.py`

### Acceptance Criteria

- entity summaries mention key relationships cleanly
- continuity improves without becoming noisy or repetitive
- graph-lite changes help early turns in new sessions

## Phase 5: Capsule And Retrieval Upgrade

### Build

- add alias-aware ranking and relation-aware ranking
- add bounded neighborhood expansion for top entities
- add graph-aware sections to the memory capsule

### Code Touchpoints

- `drost/memory_capsule.py`
- `drost/agent.py`
- `drost/storage/database.py`
- tests under `tests/test_memory_capsule.py`

### Acceptance Criteria

- relationship-heavy questions improve without extra tool calls
- the capsule remains bounded and readable
- duplicate or redundant graph snippets are suppressed

## Phase 6: Inspectability And Tooling

### Build

- extend `memory_get` for direct entity file reads
- optionally add a minimal entity-inspection tool if the existing tools are insufficient
- add better result labels and relation provenance in memory search

### Code Touchpoints

- `drost/tools/memory_get.py`
- `drost/tools/memory_search.py`
- `drost/tools/__init__.py`
- tests for tool outputs

### Acceptance Criteria

- operator and model can inspect exact entity files and relation lines
- relation search results are understandable from transcript/debug traces alone

## Phase 7: Quality Tuning

### Build

- tune merge thresholds
- tune source weighting in the capsule
- tune relation vocabulary and suppress noisy relation types
- promote stable traits/preferences into `USER.md`, `IDENTITY.md`, and `MEMORY.md`

### Code Touchpoints

- `drost/memory_capsule.py`
- `drost/memory_maintenance.py`
- `drost/prompt_assembly.py`
- workspace bootstrap templates if needed

### Acceptance Criteria

- graph-lite memory improves recall quality in real sessions
- preference and constraint promotion becomes more stable
- the system remains understandable and debuggable

## Recommended Sequence

Recommended order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 5
5. Phase 4
6. Phase 6
7. Phase 7

Reason:

- canonical files and derived index must exist before extraction can be trusted
- retrieval value appears only after the graph index exists
- continuity and summary upgrades should consume an already-stable graph substrate
- tooling is important, but not before the core data model is correct

## Rollout Strategy

Use feature flags for graph-lite additions:

- `DROST_MEMORY_GRAPH_ENABLED`
- `DROST_MEMORY_GRAPH_EXTRACTION_ENABLED`
- `DROST_MEMORY_GRAPH_CAPSULE_ENABLED`
- `DROST_MEMORY_GRAPH_PROMOTION_ENABLED`

Default recommendation:

- land file model and index first
- enable extraction locally
- tune retrieval on live conversations
- only then enable promotion into identity files by default
