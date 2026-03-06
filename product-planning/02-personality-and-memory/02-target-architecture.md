# Target Architecture

## Design Goal

Recreate the Morpheus product effect with a lean Drost stack:

- file-backed workspace context for identity and memory
- SQLite + sqvector as the index and retrieval engine
- JSONL transcripts as the debugging truth for conversations
- prompt-time assembly that makes the agent feel continuous and personal

The architecture should make Drost feel like it remembers, not just like it can search.

## Core Principle

SQLite should be the index.

The workspace should be the memory substrate.

That means:

- transcripts remain in JSONL and SQLite
- durable memory is written into Markdown files under `~/.drost`
- SQLite indexes both transcripts and workspace memory for retrieval
- prompt assembly chooses the right slices at the right time

## Personality Stack

### Workspace Files

Drost should load these files from `~/.drost`:

- `AGENTS.md`: runtime operating contract and session ritual
- `BOOTSTRAP.md`: first-run identity/user bootstrap
- `SOUL.md`: tone, values, anti-sycophancy, behavioral style
- `IDENTITY.md`: who the agent is
- `USER.md`: who the user is
- `TOOLS.md`: local tool and environment conventions
- `MEMORY.md`: curated long-term memory
- `HEARTBEAT.md`: background-run instructions

### Prompt Assembly Order

Recommended order:

1. Core runtime contract
2. Tooling and tool-call style
3. Memory recall instructions
4. Workspace path and current time
5. `AGENTS.md`
6. `BOOTSTRAP.md` when still active
7. `SOUL.md`
8. `TOOLS.md`
9. `IDENTITY.md`
10. `USER.md`
11. `MEMORY.md`
12. Recent daily memory
13. Retrieved memory capsule
14. Run-specific hints

This order matters. `SOUL.md` and `IDENTITY.md` should shape the agent before task-specific reasoning begins.

## Memory Stack

### Canonical File Layout

```text
~/.drost/
  AGENTS.md
  BOOTSTRAP.md
  SOUL.md
  IDENTITY.md
  USER.md
  TOOLS.md
  HEARTBEAT.md
  MEMORY.md
  memory/
    daily/
      YYYY-MM-DD.md
    entities/
      people/
        <entity_id>/
          items.md
          summary.md
      projects/
        <entity_id>/
          items.md
          summary.md
      organizations/
        <entity_id>/
          items.md
          summary.md
      preferences/
        <entity_id>/
          items.md
          summary.md
      goals/
        <entity_id>/
          items.md
          summary.md
```

Default entity types should match Morpheus where practical:

- people
- projects
- organizations
- places
- devices
- accounts
- preferences
- routines
- goals
- artifacts

### Indexing Model

Drost should index four source classes into SQLite:

1. session transcript spans
2. `MEMORY.md`
3. daily memory files
4. entity memory files

Each indexed item should retain:

- `source_kind`
- `path`
- `line_start`
- `line_end`
- `session_key`
- `created_at`
- `derived_from`
- keyword payload
- embedding payload

This turns SQLite into a real memory index instead of a transcript store with embeddings.

## Retrieval Model

### Baseline

Use the current hybrid approach:

- FTS for literal matching
- sqvector similarity for semantic matching
- fused ranking

### Upgrade

Retrieval should work in two modes:

1. Ambient recall:
   - automatically assemble a small memory capsule from high-value sources
   - use `MEMORY.md`, recent daily notes, and recent/important entity summaries
2. Directed recall:
   - the model calls `memory_search`
   - results return stable file or transcript references
   - the model calls `memory_get` on the exact source it wants to inspect

This is what makes memory feel both magical and inspectable.

## Maintenance and Compounding

### Extraction Runner

Build a background runner that:

- scans only new transcript lines since the last cursor
- extracts:
  - daily notes
  - durable entity facts
- appends those facts into workspace memory files
- reindexes touched memory files

This should run:

- once shortly after boot
- periodically on a schedule
- optionally after long or high-signal sessions

### Weekly Synthesis

For each entity folder:

- read `items.md`
- rewrite `summary.md`
- store synthesis timestamp in maintenance state

The runtime should prefer `summary.md` for prompt capsules and use `items.md` for exact inspection.

## Continuity

When the user starts a new session:

- summarize the previous session in the background
- inject the continuity summary into the new session
- keep the summary bounded and factual

This is the cheapest high-impact feature for making separate sessions feel like one ongoing relationship.

## Graph-Lite Instead Of Full Graph

Do not port Morpheus graph infrastructure yet.

Instead:

- use entity folders as the durable node layer
- add lightweight relation metadata in SQLite or Markdown frontmatter
- build prompt-time capsules from entity summaries and recent changes
- add simple entity lookup and related-entity retrieval later if needed

This gets most of the product value without the operational cost of a full graph store.

## Non-Goals For This Pass

- separate graph database
- opaque memory hidden only inside SQLite
- automatic persona mutation without user-visible files
- background autonomy unrelated to memory maintenance

Drost should become more personal and more magical, but not less inspectable.
