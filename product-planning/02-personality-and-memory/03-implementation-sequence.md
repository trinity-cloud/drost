# Implementation Sequence

## Phase 1: Workspace Personality Foundation

### Build

- add a real workspace loader
- support `AGENTS.md`, `BOOTSTRAP.md`, `TOOLS.md`, `HEARTBEAT.md`
- load recent daily memory files
- rebuild prompt assembly around an explicit section order

### Acceptance Criteria

- first-run Drost seeds the full workspace contract
- prompt assembly is deterministic and file-role aware
- `SOUL.md` and `IDENTITY.md` materially shape the agent voice
- `BOOTSTRAP.md` can drive the first-run identity conversation

## Phase 2: Layered Memory Files

### Build

- create `memory/daily`
- create `memory/entities/<type>/<id>`
- extend bootstrap seeding so the workspace has the expected directory structure
- treat workspace files as canonical durable memory

### Acceptance Criteria

- Drost can read and write layered memory files
- `MEMORY.md` is indexed and retrievable
- recent daily notes are prompt-injectable
- entity folders exist and are stable

## Phase 3: Unified Memory Index

### Build

- index transcripts and workspace memory files together in SQLite
- add provenance metadata
- upgrade `memory_search` to return source references
- upgrade `memory_get` to support path/line reads and transcript slices

### Acceptance Criteria

- searching for a fact can return either a transcript hit or a workspace memory hit
- retrieval results are understandable without reading code
- the agent can fetch the exact supporting lines it needs

## Phase 4: Extraction and Synthesis

### Build

- background memory maintenance runner
- transcript cursor state
- extraction into daily notes and entity facts
- weekly rewrite of entity summaries

### Acceptance Criteria

- new conversations compound into workspace memory automatically
- maintenance is incremental, not full-rescan
- entity summaries stay current enough to be useful in prompt capsules

## Phase 5: Continuity and Magical Recall

### Build

- continuity manager for `/new`
- session-start memory capsule
- adaptive recall for memory-shaped turns
- stronger recall instructions in the prompt

### Acceptance Criteria

- new sessions inherit relevant context from the previous one
- recall-heavy turns surface better context before the model starts guessing
- Drost feels continuous across sessions

## Phase 6: Graph-Lite Upgrade

### Build

- lightweight relation metadata between entities
- recent changes tracking
- prompt-time entity/relationship capsule improvements

### Acceptance Criteria

- people, projects, and preferences can be recalled with linked context
- recent changes can be surfaced without a full graph database

## Recommended Immediate Build Order

If we want the highest product lift with the least architectural regret, the sequence should be:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 5
5. Phase 4
6. Phase 6

Reason:

- without Phase 1, personality remains shallow
- without Phases 2 and 3, memory has nowhere durable to live
- Phase 5 gives immediate user-visible magic
- Phase 4 is critical, but it compounds best once the memory file model and index are already in place
- Phase 6 should follow only after the file-backed memory system proves itself
