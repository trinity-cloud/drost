# Graph Model And Files

## Canonical Rule

Markdown remains the source of truth.

SQLite remains derived.

No graph database is introduced in this phase.

## Existing Entity Layout

Drost already has:

- `memory/entities/<type>/<slug>/items.md`
- `memory/entities/<type>/<slug>/summary.md`

Graph-lite should extend this layout, not replace it.

## Proposed Entity Layout

For each entity:

- `memory/entities/<type>/<slug>/items.md`
- `memory/entities/<type>/<slug>/summary.md`
- `memory/entities/<type>/<slug>/aliases.md`
- `memory/entities/<type>/<slug>/relations.md`

Optional later:

- `memory/entities/<type>/<slug>/timeline.md`

Do not add `timeline.md` in v1 unless relation and alias quality is already stable.

## Entity Types

The initial type set should stay intentionally small:

- `people`
- `projects`
- `repos`
- `providers`
- `models`
- `tools`
- `workflows`
- `preferences`
- `constraints`
- `channels`

This is enough to express Drost's real world without taxonomy bloat.

## Aliases

`aliases.md` should be the canonical file for alternate names and handles.

Suggested shape:

```md
# Aliases

- Drost
- drost
- /Users/migel/drost
- the repo
- the agent
```

Rules:

- aliases are additive
- aliases are canonicalized deterministically in code
- exact duplicates are suppressed
- aliases should remain human-editable

## Relations

`relations.md` should hold outgoing typed edges from the current entity.

Suggested append-only shape:

```md
# Relationships (append-only)

- [id:projects/drost/relations/0001] [ts:2026-03-09] [rel:owned_by] [to:people/migel] [conf:0.99]
  Drost is owned and directed by Migel.

- [id:projects/drost/relations/0002] [ts:2026-03-09] [rel:uses_provider] [to:providers/anthropic] [conf:0.95]
  Drost uses Anthropic as one supported provider.
```

Rules:

- outgoing edges only in the owner entity's file
- `to:` always uses canonical `<type>/<slug>` form
- relation text remains natural language for inspectability
- relation ids are append-only and deterministic per entity
- supersession should be additive, not destructive

## Relation Types

Initial relation vocabulary should be controlled but not rigidly tiny.

Recommended launch set:

- `owned_by`
- `owns`
- `operated_by`
- `operates`
- `builds`
- `maintains`
- `uses_provider`
- `uses_model`
- `depends_on`
- `integrates_with`
- `deploys_with`
- `works_on`
- `prefers`
- `avoids`
- `requires`
- `supersedes`
- `part_of`
- `has_channel`
- `stored_in`

The system should validate against a configured allowlist but keep the list extensible.

## Entity Facts vs Relations

Use `items.md` for atomic facts that stand on their own.

Examples:

- Drost uses Gemini embeddings at 3072 dimensions.
- The default startup path is `uv run drost`.

Use `relations.md` when the statement is fundamentally about a connection.

Examples:

- Drost is owned by Migel.
- Drost deploys with the deployer.
- Migel prefers direct, factual answers.

Some facts can be promoted into both:

- a natural-language fact in `items.md`
- a typed edge in `relations.md`

That duplication is acceptable when it improves retrieval and inspectability.

## Derived SQLite Model

SQLite should derive graph-aware rows from the canonical files.

Recommended derived tables:

- `memory_chunks` continues to index text chunks and snippets
- `memory_entities`
  - `entity_type`
  - `entity_id`
  - `path`
  - `summary_hash`
  - `updated_at`
- `memory_entity_aliases`
  - `entity_type`
  - `entity_id`
  - `alias`
  - `alias_normalized`
- `memory_relations`
  - `from_entity_type`
  - `from_entity_id`
  - `relation_type`
  - `to_entity_type`
  - `to_entity_id`
  - `relation_text`
  - `confidence`
  - `path`
  - `line_start`
  - `line_end`
  - `updated_at`

This does not replace the current chunk index. It supplements it.

## Why This Model Is Correct

This model gives us:

- human-editable source files
- deterministic indexing
- semantic retrieval over summaries and relation text
- explicit edge traversal without a separate database service
- a clean upgrade path later if graph depth or scale increases
