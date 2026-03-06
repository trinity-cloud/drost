# Personality and Memory

## Goal

Shift Drost from a capable tool-using agent into a personal AI with:

- a stable, inspectable personality that lives in the workspace
- memory that compounds over time instead of only retrieving transcript chunks
- recall that feels "magical" because the right context appears at the right time

Morpheus is the north star. The point is not to blindly port every subsystem. The point is to preserve the product behavior that makes Morpheus feel alive while keeping Drost lean:

- keep SQLite + sqvector as the persistence substrate
- keep workspace files as the source of truth
- keep JSONL transcripts for debugability
- defer full graph infrastructure until file-backed and SQLite-backed memory layers are strong

## Documents

- `01-feature-matrix.md`: Morpheus-to-Drost capability matrix with recommended implementation targets
- `02-target-architecture.md`: lean Drost architecture for personality and magical memory
- `03-implementation-sequence.md`: phased build order with acceptance criteria

## Source Basis

This package is based on the current Drost codebase and these Morpheus reference points:

- `morpheus/workspace/loader.py`
- `morpheus/workspace/prompt.py`
- `morpheus/memory/maintenance.py`
- `morpheus/sessions/continuity.py`
- `morpheus/graph/context.py`
- `sample-workspace/AGENTS.md`
- `sample-workspace/BOOTSTRAP.md`
- `sample-workspace/SOUL.md`
- `product-planning/15-memory/*`

Current-state Drost comparison was grounded in:

- `drost/prompt_assembly.py`
- `drost/agent.py`
- `drost/config.py`
- `drost/tools/memory_search.py`
- `drost/tools/memory_get.py`
- `drost/storage/database.py`
- `drost/workspace_bootstrap.py`

## Bottom Line

The next serious Drost build should focus on five things:

1. Richer workspace personality loading: `AGENTS.md`, `BOOTSTRAP.md`, `TOOLS.md`, `HEARTBEAT.md`, recent daily memory
2. Layered file-backed memory: `MEMORY.md`, `memory/daily`, `memory/entities`
3. Real memory compounding: scheduled extraction and weekly synthesis from transcripts into workspace memory
4. Better recall primitives: search/index both workspace memory files and transcripts, with path/line reads
5. Continuity and prompt-time memory capsules so new sessions and recall-heavy turns feel seamless

## What Not To Port Yet

These should stay out of the first Drost memory pass:

- a separate graph database
- heavy multi-agent orchestration
- provider-specific memory behaviors
- opaque internal-only memory state that cannot be inspected from files or SQLite

The first Drost version of "magical memory" should be understandable on disk.
