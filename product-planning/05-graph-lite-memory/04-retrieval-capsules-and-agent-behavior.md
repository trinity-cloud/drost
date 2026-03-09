# Retrieval, Capsules, And Agent Behavior

## Retrieval Goal

Graph-lite memory should improve pre-tool reasoning.

The model should receive the most relevant connected context before it starts guessing or issuing rediscovery tool calls.

## What Should Change In Retrieval

Current capsule inputs are mostly:

- `MEMORY.md`
- continuity summary
- daily memory
- entity summaries
- entity items
- transcript snippets

Graph-lite should add two new retrieval surfaces:

- aliases
- relations

And one new retrieval behavior:

- neighborhood expansion

## Alias-Aware Retrieval

If a user says:

- `the repo`
- `/Users/migel/drost`
- `Drost`
- `the agent`

retrieval should map those to the same underlying entity when alias evidence is strong.

This should improve both:

- search recall
- result deduplication

## Relation Retrieval

Relation rows should participate in unified memory search as first-class memory rows.

Recommended source kinds:

- `entity_relation`
- `entity_alias`

Alias rows usually should not surface directly in the prompt, but they should influence ranking and entity resolution.

Relation rows should surface when the question is relationship-heavy.

Examples:

- who owns this?
- what does this depend on?
- how are these connected?
- what constraints apply to this workflow?

## Neighborhood Expansion

After selecting a top entity candidate, Drost should optionally fetch a bounded one-hop neighborhood from `memory_relations`.

Example:

If `projects/drost` is selected, one-hop expansion may add:

- `people/migel`
- `tools/deployer`
- `providers/anthropic`
- `channels/telegram`

This should be bounded tightly.

Recommended v1 limits:

- expand at most 2 primary entities
- include at most 4 relation neighbors total
- prefer higher-confidence and more recently updated edges

## Capsule Shape

The capsule should gain graph-aware sections.

Suggested shape:

```md
[Memory Capsule]
[Relevant MEMORY.md]
...
[Session Continuity]
...
[Relevant Entities]
- projects/drost: ...
- people/migel: ...

[Relevant Relationships]
- projects/drost owned_by people/migel
- projects/drost deploys_with tools/deployer
- people/migel prefers workflows/direct-factual-answers

[Relevant Daily Memory]
...
```

The point is not verbosity. The point is connected grounding.

## Agent Behavior Changes

Graph-lite should reduce several bad behaviors:

- re-discovering obvious project context through file reads
- losing user preference context when the query is project-specific
- answering with isolated facts instead of connected explanations

It should improve behaviors like:

- knowing what system component belongs to what subsystem
- carrying stable user and project constraints into execution decisions
- answering relationship questions without extra tool calls

## Tooling Implications

Phase 1 should avoid tool proliferation.

But two inspectability upgrades are worth planning:

- `memory_get` should be able to return entity files directly
- later, a `memory_neighbors` or `entity_inspect` tool may be justified

That tool should come only after the index model is stable.

## Why This Retrieval Design Is Correct

This gives Drost graph benefits without overbuilding:

- no new serving tier
- no graph query language
- no runtime complexity explosion
- just better ranking, bounded edge expansion, and clearer prompt context
