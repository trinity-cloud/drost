# Graph-Lite Memory

## Goal

Add explicit entity and relationship memory on top of Drost's existing magical-memory stack.

The target product effect is straightforward:

- Drost should know not just isolated facts, but how people, projects, tools, providers, repos, preferences, and constraints relate to each other.
- Drost should stop relying on transcript luck to recover important connections.
- Memory should remain inspectable and editable from disk.

This package assumes the current stack is already in place:

- workspace bootstrap and loader
- daily memory
- entity facts
- entity summaries
- continuity
- prompt-time memory capsule
- deployer control plane

## Why This Package Exists

Drost now has durable memory, but it still thinks mostly in flat snippets.

That is good enough for:

- recall of concrete prior facts
- session carryover
- prompt-time grounding

It is not good enough for:

- entity disambiguation
- understanding relationships across multiple sessions
- answering questions like "how are X and Y connected?"
- promoting stable user preferences and operating constraints into durable structure
- keeping long-running projects coherent over time

The next lift in quality is graph-lite memory, not a full graph database.

## Documents

- `01-current-state-and-gap.md`: exact gap between current memory and relationship-aware memory
- `02-graph-model-and-files.md`: canonical on-disk entity and relation model
- `03-extraction-and-resolution.md`: how transcripts become resolved entities, aliases, and relations
- `04-retrieval-capsules-and-agent-behavior.md`: how graph-lite memory reaches the model at turn time
- `05-write-path-and-lifecycle.md`: maintenance, synthesis, continuity, and promotion flows
- `06-implementation-workplan.md`: concrete build order with code touchpoints and acceptance criteria
- `07-test-observability-and-risks.md`: tests, metrics, rollout strategy, and major failure modes

## Design Constraints

This package intentionally preserves Drost's current architectural choices:

- Markdown files stay canonical.
- SQLite stays the derived search/index layer.
- Gemini embeddings stay the semantic retrieval backend.
- The gateway process keeps ownership of maintenance work.
- Drost remains lean; do not add a separate graph database.

## Current Code Basis

This package is grounded in the current Drost implementation:

- `/Users/migel/drost/drost/memory_files.py`
- `/Users/migel/drost/drost/memory_maintenance.py`
- `/Users/migel/drost/drost/storage/memory_indexer.py`
- `/Users/migel/drost/drost/memory_capsule.py`
- `/Users/migel/drost/drost/session_continuity.py`
- `/Users/migel/drost/drost/workspace_loader.py`
- `/Users/migel/drost/drost/prompt_assembly.py`
- `/Users/migel/drost/drost/storage/database.py`

## Bottom Line

Drost has crossed the threshold where more undifferentiated tools or providers matter less than better memory structure.

The next serious build should do five things:

1. Resolve repeated mentions to stable entities.
2. Store explicit typed relationships between those entities.
3. Rank and inject relationship-aware context before the model starts reasoning.
4. Keep the whole system file-backed, inspectable, and recoverable.
5. Avoid graph-database complexity drift.

## Recommendation

Build graph-lite memory as the next memory-quality subsystem.

Do it in one disciplined pass:

- canonical files first
- derived SQLite graph index second
- extraction and resolution third
- retrieval and capsule integration fourth
- continuity and synthesis tuning last
