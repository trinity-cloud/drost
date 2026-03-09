# Extraction And Resolution

## Core Principle

Extraction should remain LLM-assisted, but resolution and writes must stay deterministic.

That same design choice worked for memory maintenance and should continue here.

## What The Runner Should Extract

From transcript slices and tool traces, the maintenance runner should extract structured JSON with four sections:

- `entities`
- `aliases`
- `facts`
- `relations`

Suggested shape:

```json
{
  "entities": [
    {
      "entity_type": "projects",
      "entity_name": "Drost",
      "summary_hint": "AI agent runtime and deployable Telegram-based system"
    }
  ],
  "aliases": [
    {
      "entity_type": "projects",
      "entity_name": "Drost",
      "alias": "/Users/migel/drost"
    }
  ],
  "facts": [
    {
      "entity_type": "projects",
      "entity_name": "Drost",
      "kind": "architecture",
      "fact": "Drost uses a supervised deployer as the default startup path.",
      "confidence": 0.96
    }
  ],
  "relations": [
    {
      "from_entity_type": "projects",
      "from_entity_name": "Drost",
      "relation_type": "owned_by",
      "to_entity_type": "people",
      "to_entity_name": "Migel",
      "statement": "Drost is owned and directed by Migel.",
      "confidence": 0.99
    }
  ]
}
```

The LLM should not choose canonical slugs directly. It should propose names. Runtime code resolves those names.

## Resolution Pipeline

Resolution should be deterministic and ordered.

### Step 1: Normalize Candidate

For each candidate entity name:

- trim whitespace
- normalize case for matching
- preserve original form for human-readable storage
- derive candidate slug with the existing slugger from `memory_files.py`

### Step 2: Exact Alias Match

Check existing alias rows first.

If alias matches an existing canonical entity, reuse that entity.

This should be the highest-confidence merge path.

### Step 3: Exact Canonical Match

Check whether `<type>/<slug>` already exists.

If yes, reuse it.

### Step 4: Strong Similarity Match

If no exact match exists, compare against:

- canonical entity id
- alias rows
- summary title
- entity summary embedding

Use a conservative threshold. False merges are worse than duplicate nodes.

### Step 5: Create New Canonical Entity

If no strong match exists, create a new entity directory under `memory/entities/<type>/<slug>`.

## Relation Resolution

A relation should only be written if both endpoints resolve successfully.

If one endpoint does not resolve cleanly:

- either create the missing endpoint first
- or drop the relation from that extraction batch if confidence is low

Never write dangling edges.

## Confidence Handling

Recommended thresholds:

- `>= 0.90`: write automatically
- `0.75 - 0.89`: write if corroborated by transcript/tool evidence in the same batch
- `< 0.75`: skip for now

This should be configurable, but conservative by default.

## Supersession

Graph-lite needs additive change handling.

Do not rewrite old facts or relations in place.

Instead:

- append a new relation or fact
- optionally mark `supersedes:<old-id>`
- let synthesis prefer newer, higher-confidence records

This preserves auditability.

## Promotion Into Durable Identity Files

Not everything belongs only in entity files.

Some resolved graph facts should also promote into higher-level workspace files when stable:

- user preferences -> `USER.md`
- agent identity -> `IDENTITY.md`
- broad durable truths -> `MEMORY.md`

Graph-lite should make those promotions safer by grounding them in explicit entities and relations.

## Why This Extraction Model Is Correct

This approach avoids both bad extremes:

- not regex-only brittle extraction
- not unbounded LLM-controlled file mutation

The model decides semantic candidates.
The runtime owns canonical resolution, file writes, and dedupe.
