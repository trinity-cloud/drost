# Memory System

Drost has a layered memory architecture designed to compound knowledge across sessions while keeping each turn's context window focused and bounded.

## Memory Layers

### Layer 1: Raw Session Logs

Every conversation turn is recorded as JSONL:

```
~/.drost/sessions/<session-key>.jsonl        # user/assistant pairs
~/.drost/sessions/<session-key>.full.jsonl   # full tool-call trace
```

These are the immutable source of truth. They're used by the maintenance loop for extraction and by continuity for summarization.

### Layer 2: Durable Workspace Memory

The maintenance loop compounds session logs into human-readable Markdown:

```
~/.drost/MEMORY.md                              # top-level memory file
~/.drost/memory/daily/YYYY-MM-DD.md             # daily summaries
~/.drost/memory/entities/<type>/<id>/items.md    # atomic facts
~/.drost/memory/entities/<type>/<id>/aliases.md  # known names/aliases
~/.drost/memory/entities/<type>/<id>/relations.md # relationships
~/.drost/memory/entities/<type>/<id>/summary.md  # entity summary
```

Entity types include: `people`, `projects`, `repos`, `providers`, `models`, `tools`, `workflows`, `preferences`, `constraints`, `channels`.

These files are the long-lived memory substrate. They're human-readable, version-controllable, and directly editable.

### Layer 3: Unified Derived Index

A SQLite database indexes all memory sources with embeddings for similarity search:

- Transcript messages
- Workspace memory files (synced by `WorkspaceMemoryIndexer`)
- Continuity summaries

**Embedding configuration:**

| Setting | Default |
|---------|---------|
| `DROST_MEMORY_EMBEDDING_PROVIDER` | `gemini` |
| `DROST_MEMORY_EMBEDDING_MODEL` | `gemini-embedding-001` |
| `DROST_MEMORY_EMBEDDING_DIMENSIONS` | `3072` |

Vector search uses `sqlite-vec` when available. If the extension isn't found, Drost falls back to brute-force cosine similarity. When embedding dimensions change, the derived vector lane is rebuilt automatically.

### Layer 4: Session Continuity

When you start a new session with `/new`, Drost can summarize the previous session and inject the carryover into early turns of the new one.

The continuity summary follows a structured format:
- Core Objective
- Decisions And Constraints
- Work Completed
- Open Threads
- Suggested Next Actions

Continuity is also indexed as a searchable memory source, so relevant context from old sessions can surface in future turns.

### Layer 5: Memory Capsule (Prompt-Time)

Before each turn, Drost builds a bounded memory capsule from all available sources. The capsule builder:

1. **Ranks candidates** by fused score (vector similarity + source boost + lexical overlap).
2. **Selects by source type** with per-type limits to ensure diversity:
   - `workspace_memory` (1), `session_continuity` (1), `daily_memory` (2), `entity_summary` (2), `entity_relation` (3), `entity_item` (1), `transcript_message` (2), `transcript_tool` (1)
3. **Falls back** to transcript recall only when higher-order memory is weak.
4. **Truncates** to the memory token budget.

This means the agent always gets the most relevant memory without blowing the context window.

### Layer 6: Graph-Lite Relationships

Entity resolution by alias matching enables graph-like traversal:

- Find entities mentioned in the query text.
- Load their summaries.
- Traverse neighbors via relationships (up to 4 hops).
- Inject related entity summaries into the memory capsule.

This gives the agent relationship-aware context (e.g., "who owns project X?" resolves through entity relations).

## Memory Maintenance

The maintenance loop runs in the background (default: every 30 minutes) and processes new JSONL transcript entries:

1. **Tail-scans** session JSONL files for unprocessed entries.
2. **Extracts daily memory** — summarizes conversation content into `memory/daily/YYYY-MM-DD.md`.
3. **Extracts entities** — identifies people, projects, preferences, etc. with atomic facts.
4. **Resolves entities** — matches against existing entities by alias to avoid duplicates.
5. **Synthesizes entity summaries** — generates/updates `summary.md` for entities with enough facts.
6. **Extracts follow-ups** — identifies concrete follow-up actions with due dates and priorities.
7. **Syncs the workspace memory index** — re-embeds updated Markdown files.

## Follow-Up Memory

Follow-ups are stored in `~/.drost/memory/follow-ups.json` and tracked with:

- Subject and detailed prompt
- Priority (low/medium/high/critical)
- Due date and snooze-until
- Source session and entity references
- Status (pending/surfaced/completed/dismissed/expired)

The heartbeat loop reviews due follow-ups during idle time and can proactively surface them via Telegram.

## Configuration

Key memory settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `DROST_MEMORY_ENABLED` | `true` | Master switch for memory |
| `DROST_MEMORY_TOP_K` | `6` | Default search result count |
| `DROST_MEMORY_CAPSULE_ENABLED` | `true` | Enable prompt-time capsule |
| `DROST_MEMORY_CAPSULE_SEARCH_LIMIT` | `18` | Candidates to consider |
| `DROST_MEMORY_MAINTENANCE_ENABLED` | `true` | Enable background extraction |
| `DROST_MEMORY_MAINTENANCE_INTERVAL_SECONDS` | `1800` | Maintenance cycle interval |
| `DROST_MEMORY_ENTITY_SYNTHESIS_ENABLED` | `true` | Enable entity summary generation |
| `DROST_MEMORY_CONTINUITY_ENABLED` | `true` | Enable session continuity |
| `DROST_MEMORY_CONTINUITY_AUTO_ON_NEW` | `true` | Auto-summarize on `/new` |
| `DROST_FOLLOWUPS_ENABLED` | `true` | Enable follow-up extraction |
