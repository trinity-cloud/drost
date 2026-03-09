# Canonical Memory Model

## Principle

Canonical durable memory should live in Markdown under `~/.drost`.

Use cases split cleanly:

- `JSONL`: raw conversations and tool traces
- `Markdown`: durable memory that the agent and user can inspect and edit
- `SQLite`: retrieval index over both

Do not make JSONL the canonical memory layer for this phase.

## Directory Layout

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
        <slug>/
          items.md
          summary.md
      projects/
        <slug>/
          items.md
          summary.md
      organizations/
        <slug>/
          items.md
          summary.md
      places/
        <slug>/
          items.md
          summary.md
      devices/
        <slug>/
          items.md
          summary.md
      accounts/
        <slug>/
          items.md
          summary.md
      preferences/
        <slug>/
          items.md
          summary.md
      routines/
        <slug>/
          items.md
          summary.md
      goals/
        <slug>/
          items.md
          summary.md
      artifacts/
        <slug>/
          items.md
          summary.md
  state/
    memory-maintenance.json
    continuity.json
```

## Memory Layers

### Layer 0: Workspace Identity Files

These are not "memory" in the extraction sense, but they are durable identity context.

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `AGENTS.md`
- `HEARTBEAT.md`

They should stay in the workspace contract and continue to be reread every prompt build.

### Layer 1: Curated Long-Term Memory

`MEMORY.md` should remain the highest-signal human-readable memory file.

Use it for:

- enduring preferences
- long-running relationship context
- broad user profile facts
- recurring project context
- important lessons and decisions

This file should be concise, curated, and heavily reused in prompt-time capsules.

### Layer 2: Daily Memory

`memory/daily/YYYY-MM-DD.md` should capture the recent stream of life and work.

Use it for:

- what happened today
- what changed
- what is in flight
- small facts not yet worthy of `MEMORY.md`
- daily notes pulled from transcripts

Daily files are the bridge between raw chat and durable long-term memory.

Recommended format:

```md
# 2026-03-06

- Discussed rollout of Drost workspace bootstrap files.
- Added vision support across OpenAI Codex, Anthropic, and xAI.
- User wants memory to compound through Markdown, not hidden state.
```

Keep them append-only within a day.

### Layer 3: Entity Memory

Each entity folder should contain two files.

#### `items.md`

Append-only atomic facts.

Example:

```md
# Atomic Facts (append-only)

- [id:projects/drost/0001] [ts:2026-03-06] [kind:status] [conf:0.95]
  Drost is an open-source stripped-down version of reference implementation.

- [id:projects/drost/0002] [ts:2026-03-06] [kind:capability] [conf:0.91]
  Drost supports OpenAI Codex OAuth, Anthropic, and xAI providers.
```

Rules:

- append-only
- stable IDs
- no fuzzy rewrites in place
- skip exact duplicate facts
- support `supersedes` metadata later if needed

#### `summary.md`

A compact synthesized snapshot of the entity.

Use it for:

- prompt-time memory capsules
- quick recall
- grounding the model before it drills into exact facts

Example:

```md
# Drost

Drost is Migel's open-source personal agent runtime. It runs through Telegram and a FastAPI gateway, supports three model providers, and is currently moving from transcript-only recall toward layered file-backed memory.
```

## Entity Types

Default entity types should match the reference implementation maintenance runner where practical:

- `people`
- `projects`
- `organizations`
- `places`
- `devices`
- `accounts`
- `preferences`
- `routines`
- `goals`
- `artifacts`

Do not add a graph database yet. Entity folders are the durable node layer for now.

## Source-Of-Truth Rules

### Rule 1

Raw session JSONL is the ground-truth experience log.

### Rule 2

Markdown memory files are the canonical durable memory.

### Rule 3

SQLite is a derived searchable index and may always be rebuilt.

### Rule 4

If a fact matters long term, it must end up in a memory file.

## Embedding Backend

The unified memory index should use Google's Gemini embeddings API.

Standard choice:

- provider: Gemini
- model: `gemini-embedding-001`
- auth env var: `GEMINI_API_KEY`
- vector size: full default `3072`

Operational rules:

- do not set reduced `output_dimensionality`
- shape SQLite and `sqlite-vec` storage around `3072`
- embed indexed memory chunks with retrieval-document semantics
- embed live search queries with retrieval-query semantics

This keeps the memory system aligned with the current Google embedding API instead of carrying forward the earlier OpenAI embedding defaults.

## Bootstrap And Seeding

The workspace bootstrap already creates:

- `memory/daily`
- `memory/entities`

The next pass should extend seeding with placeholder `.gitkeep`-style directories only where needed. It should not pre-generate entity files.

## What Not To Do

Do not:

- store durable facts only inside SQLite rows
- create opaque binary state for memory meaning
- overcomplicate the file model with many tiny machine-owned sidecar files
- rewrite daily files aggressively

Keep the model simple enough that a user can inspect the workspace and immediately understand how memory works.
