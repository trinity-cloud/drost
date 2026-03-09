# Write Path And Lifecycle

## Lifecycle Goal

Graph-lite memory should compound gradually and predictably.

It should not turn every message into aggressive graph churn.

## Write Sources

The write pipeline should remain software-owned and asynchronous.

Primary sources:

- session `.jsonl`
- session `.full.jsonl`
- existing workspace memory files

The maintenance runner should remain the main writer.

## Write Events

Graph-lite writes should occur during these events:

### 1. Periodic Maintenance Run

The existing background maintenance interval remains the main write cadence.

This is where entity and relation extraction should happen.

### 2. Explicit Manual Run

The existing maintenance trigger endpoints should continue to support one-shot runs.

Useful for:

- debugging extraction quality
- backfilling after prompt changes
- recovering after downtime

### 3. Entity Touch Synthesis

If an entity receives new facts or relations, it should be marked dirty for later summary regeneration.

Summary and relation synthesis should not run on every single append.

## Dirty-State Model

Recommended dirty tracking:

- `state/graph-maintenance.json`
- `dirty_entities`
- `last_relation_extraction_cursor`
- `last_alias_extraction_cursor`
- `last_graph_summary_run_at`

The system should be resumable after restart.

## File Writes

Graph-lite adds two new write paths:

- append to `aliases.md`
- append to `relations.md`

Rules:

- never overwrite append-only relation history during extraction
- suppress exact duplicates
- allow later synthesis to produce cleaner summaries from raw history

## Entity Summary Synthesis

Existing `summary.md` generation should become graph-aware.

A good summary should synthesize:

- what the entity is
- important stable facts
- key relationships
- current role in the system
- important constraints or preferences

Example for `projects/drost`:

- owned by Migel
- runs as an AI agent with Telegram channel
- uses Anthropic/OpenAI Codex/xAI providers
- uses Gemini embeddings for memory
- deploys through the deployer control plane

## Continuity Integration

Session continuity should start drawing on graph-lite memory.

The continuity summary should be able to mention:

- active entities touched in the prior session
- important changed relationships
- promoted preferences or constraints

This should remain bounded. Continuity is not the graph dump.

## Promotion Into Workspace Identity Files

Graph-lite should enable safer promotion into:

- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`

Suggested rule:

- only promote when the same preference, trait, or system truth appears repeatedly or is explicitly confirmed

This avoids one-off noise becoming identity.

## Why This Lifecycle Is Correct

It preserves the existing Drost discipline:

- background semantic extraction
- deterministic write envelope
- append-only auditability
- bounded synthesis
- no new daemon requirements
