# Test, Observability, And Risks

## Test Strategy

### Unit Tests

Cover deterministic graph primitives:

- alias normalization
- relation id generation
- duplicate suppression
- relation parsing from `relations.md`
- entity resolution exact-match behavior
- conservative merge behavior around similar aliases

### Integration Tests

Cover real flows:

- transcript -> extraction JSON -> file writes -> index rows
- entity summary regeneration after relation updates
- continuity generation with graph-aware summaries
- graph-aware capsule assembly for relationship-heavy queries

### Regression Tests

Add explicit regressions for:

- wrong-entity merges
- alias fragmentation
- duplicate relation spam
- relationship-heavy questions failing to surface the right entity neighborhood
- graph data overwhelming the prompt budget

## Observability

Add graph-specific metrics and trace fields.

Recommended metrics:

- `graph_entities_created`
- `graph_entities_reused`
- `graph_aliases_written`
- `graph_relations_written`
- `graph_relation_duplicates_suppressed`
- `graph_entity_merge_candidates`
- `graph_entity_merge_accepts`
- `graph_entity_merge_rejects`
- `graph_capsule_neighbors_loaded`
- `graph_capsule_relation_hits`

Recommended per-run debug fields:

- resolved entities touched
- relation rows surfaced in capsule
- neighbor expansion count
- promotion decisions into `USER.md` / `IDENTITY.md` / `MEMORY.md`

## Evaluation Plan

Use real transcripts and targeted prompts.

Good evaluation questions:

- who owns Drost?
- what does Drost depend on for deployment?
- how are the deployer and the gateway connected?
- what preferences has the user expressed about safety and permissions?
- what changed about startup mode recently?

The objective is not just retrieval hit rate. It is connected correctness.

## Main Risks

### 1. False Entity Merges

This is the highest-risk failure mode.

If two entities are merged incorrectly, downstream summaries and relations become polluted.

Bias toward under-merging.

### 2. Relation Explosion

If extraction is too eager, `relations.md` becomes noisy and unreadable.

Keep relation vocabulary controlled and confidence thresholds conservative.

### 3. Prompt Overload

If neighborhood expansion is not bounded, graph-lite memory will crowd out more important immediate context.

Capsules must stay disciplined.

### 4. Preference Over-Promotion

A single transient statement should not become durable identity.

Promotion into `USER.md`, `IDENTITY.md`, and `MEMORY.md` must require repeated evidence or explicit confirmation.

### 5. Complexity Drift

The point is graph-lite memory, not a hidden graph platform.

Do not add:

- graph query DSLs
- separate graph services
- multi-hop traversals by default
- auto-generated opaque state blobs as the source of truth

## Rollout Recommendation

Roll this out in three stages:

1. File model + index only
2. Extraction + retrieval locally with transcript inspection
3. Promotion and continuity upgrades after quality is proven

That keeps the blast radius contained while still moving the product meaningfully forward.
