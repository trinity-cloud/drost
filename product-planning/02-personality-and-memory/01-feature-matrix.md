# Feature Matrix

## Legend

- `P0`: build next
- `P1`: build immediately after P0
- `P2`: later, after the core memory system is working

## Personality and Identity

| Capability | Morpheus | Drost Today | Recommended Drost Implementation | Priority |
| --- | --- | --- | --- | --- |
| Workspace contract | Loads `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `BOOTSTRAP.md`, optional `HEARTBEAT.md`, `MEMORY.md`, and recent daily memory via `morpheus/workspace/loader.py` | Loads only `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` when present via `drost/prompt_assembly.py` | Add a real workspace loader with explicit file roles, optional session-aware inclusion, frontmatter stripping, size caps, and `memory/daily` loading | `P0` |
| First-run identity ritual | `BOOTSTRAP.md` seeds the first conversation and teaches the agent who it is and who the user is | No first-run ritual; workspace files are seeded but inert | Seed `BOOTSTRAP.md` and teach the agent to complete first-run identity formation, then mark bootstrap complete or archive the file | `P0` |
| Personality source of truth | `SOUL.md` defines tone, opinions, behavioral norms, and anti-sycophancy rules | Generic runtime prompt plus optional `SOUL.md` text injection | Make `SOUL.md` the primary personality authority; reduce generic runtime prose so persona comes from files, not hardcoded prompt text | `P0` |
| Identity embodiment | `IDENTITY.md` gives the agent a name, creature, vibe, emoji, and self-concept | Seeded file exists, but there is no explicit identity parsing or first-run filling workflow | Parse lightweight identity fields for runtime metadata and ensure bootstrap flow fills them on first run | `P0` |
| User model | `USER.md` stores user context, timezone, preferences, and relationship context | Seeded file exists, but no dedicated retrieval semantics | Treat `USER.md` as a high-priority prompt block and a durable source for personalization | `P0` |
| Tool-specific operational notes | `TOOLS.md` stores environment-specific instructions for tools and local conventions | No `TOOLS.md` support | Add `TOOLS.md` to the workspace contract for repo-specific and machine-specific tool guidance | `P0` |
| Session-aware prompt assembly | Morpheus varies what is injected for main sessions, group sessions, minimal runs, and heartbeat runs | Prompt assembly is static across turn types | Add session/run modes so Drost can omit private memory in the wrong contexts and include heartbeat instructions only when needed | `P1` |
| Time and workspace grounding | Morpheus injects explicit workspace path, timezone, and current time | Drost includes provider/tool hints but not a structured workspace/time section | Add explicit workspace and clock sections so the agent is grounded in place and time before reasoning | `P0` |
| Tool call style guidance | Morpheus prompt tells the model when to narrate and when to silently act | Drost has a tool execution contract but not a style contract | Add a short tool-call style section so the agent sounds intentional instead of chatty or robotic | `P1` |
| Heartbeat behavior | `HEARTBEAT.md` gives separate instructions for background maintenance runs | No heartbeat prompt layer | Add heartbeat-specific prompt support once background maintenance exists | `P2` |

## Memory Model and Retrieval

| Capability | Morpheus | Drost Today | Recommended Drost Implementation | Priority |
| --- | --- | --- | --- | --- |
| Layered memory model | Three layers: `MEMORY.md`, `memory/daily/YYYY-MM-DD.md`, `memory/entities/<type>/<id>/...` | Transcript chunks in SQLite plus a manually editable `MEMORY.md` file | Adopt the same three-layer file layout inside `~/.drost` while keeping SQLite as the index | `P0` |
| Workspace memory indexing | Indexes workspace memory files and transcripts together | Only transcript chunks are indexed in SQLite | Index `MEMORY.md`, daily memory files, and entity files alongside transcripts so recall spans both learned and curated memory | `P0` |
| Hybrid search | Uses keyword + vector retrieval over indexed memory | Uses SQLite FTS + sqvector over transcript chunks only | Extend current hybrid retrieval to all memory sources and return source metadata, not only chunk ids | `P0` |
| Memory search source fidelity | Results identify paths and snippets from memory files and sessions | Results identify transcript chunk ids and session keys only | Return `source_kind`, `path`, line ranges, session metadata, and snippet so results are understandable and stable | `P0` |
| Memory get semantics | Reads exact files or transcript slices | Reads a full chunk by numeric id | Change `memory_get` to accept path + line range and transcript references; keep chunk-id lookup only as a legacy fallback | `P0` |
| Daily notes | Maintains `memory/daily/YYYY-MM-DD.md` and injects today + yesterday into prompt context | No daily notes layer | Create daily notes files and load today + yesterday into the prompt by default | `P0` |
| Durable entity memory | Maintains append-only `items.md` plus synthesized `summary.md` per entity | No entity memory layer | Add `memory/entities/<entity_type>/<entity_id>/items.md` and `summary.md` as the backbone of durable recall | `P0` |
| Tacit memory | `MEMORY.md` serves as curated long-term memory | `MEMORY.md` exists but is not tightly integrated into retrieval or maintenance | Treat `MEMORY.md` as a first-class indexed source and a human-editable memory layer | `P0` |
| Transcript indexing | Session transcripts are searchable as memory | Drost already embeds and indexes transcript chunks | Keep this, but merge it into a multi-source memory index instead of a transcript-only memory system | `P0` |
| Exact recall lane | Morpheus planning explicitly calls for literal/exact recall handling for sensitive data | No exact-match memory lane beyond normal FTS | Add literal keyword-first retrieval for names, codes, handles, dates, and exact phrases before semantic expansion | `P1` |
| Secret scrubbing before embeddings | Morpheus planning calls out secret scrubbing before third-party embedding calls | Drost sends raw text to embedding provider | Add a redaction pass for likely secrets before embedding workspace files and transcripts | `P1` |
| Memory provenance | Morpheus memory can be traced back to files and transcript lines | Drost memory is harder to inspect because it is chunk-oriented | Preserve provenance fields for every indexed item: origin path, line range, session key, created_at, derived_from | `P0` |

## Memory Compounding and Continuity

| Capability | Morpheus | Drost Today | Recommended Drost Implementation | Priority |
| --- | --- | --- | --- | --- |
| Automated extraction | `morpheus/memory/maintenance.py` periodically extracts daily notes and durable facts from new transcripts | No background extraction into workspace memory | Build a maintenance runner that scans new transcript lines and writes daily notes plus entity facts into workspace files | `P0` |
| Weekly synthesis | Morpheus rewrites entity summaries on a weekly cadence | No synthesis pass | Add periodic summary generation for entity folders so recall can prefer compact summaries before raw fact lists | `P1` |
| Incremental processing state | Morpheus stores per-transcript cursors so only new material is processed | No maintenance state | Add a state file under `~/.drost` that tracks transcript cursors and last synthesis times | `P0` |
| Continuity across `/new` sessions | Morpheus asynchronously generates a carryover summary and injects it into the new session | Drost creates timestamped sessions but does not inject continuity | Add a background continuity manager that summarizes the prior session into the new one on `/new` or explicit session branch operations | `P0` |
| Memory maintenance triggering | Morpheus kicks maintenance once soon after boot and then on a schedule | No automated maintenance cadence | Run maintenance once on startup, then periodically, and optionally after long or high-signal conversations | `P1` |
| Compaction of old chat history | Morpheus has transcript compaction and continuity-aware history management | Drost has basic summary compaction for context budget control | Keep Drost’s compaction, but ensure it feeds maintenance and continuity rather than acting as the only long-term retention path | `P1` |
| Human-editable memory compounding | Morpheus compounds into files that can be inspected and edited | Drost compounds only into SQLite transcript chunks | Make file-backed memory the main durable layer, with SQLite acting as an index rather than the canonical store | `P0` |
| Runs and memory observability | Morpheus treats memory writes and continuity as explicit subsystems | Drost has transcripts and traces, but memory maintenance is absent | Add maintenance logs, extraction summaries, and changed-file traces so memory behavior is auditable | `P1` |

## Prompt-Time "Magical Memory"

| Capability | Morpheus | Drost Today | Recommended Drost Implementation | Priority |
| --- | --- | --- | --- | --- |
| Session-start memory capsule | Morpheus can inject a compact graph/context snapshot at session start | No session-start recall capsule beyond retrieved transcript snippets | Add a bounded "memory capsule" at session start built from `MEMORY.md`, recent daily notes, and top entity summaries | `P1` |
| Adaptive recall on memory-shaped queries | Morpheus has graph-relevance heuristics and dynamic retrieval refresh | Drost only preloads top-k transcript memories for every query | Add heuristics for recall-heavy turns and use them to fetch targeted memory context before or during the loop | `P1` |
| Entity/relationship context | Morpheus uses graph context for people, projects, preferences, and timelines | No graph or entity relationship layer | Start with graph-lite over entity files and SQLite metadata instead of a separate graph database | `P1` |
| Recent changes recall | Morpheus can inject recent graph changes into prompt context | No "recent changes" surface | Track recently updated entities and daily notes, then inject a small recent-changes block when relevant | `P2` |
| Prompt order discipline | Morpheus has a consistent order: tooling, memory instructions, workspace, time, workspace files, runtime hints | Drost prompt assembly is simpler and flatter | Rebuild prompt assembly around an explicit section order so personality and memory sit in predictable, controllable slots | `P0` |
| Recall instructions in system prompt | Morpheus explicitly tells the model to use memory and graph tools before answering recall questions | Drost does not strongly distinguish recall questions from ordinary turns | Add a dedicated memory recall section that tells Drost when to search memory, when to fetch exact lines, and when to admit uncertainty | `P0` |
| File-backed relationship memory | Morpheus planning pushes toward rich entity relationships | Drost has no relationship storage | Add lightweight relation metadata in SQLite or entity frontmatter as a stepping stone toward future graph tools | `P2` |
| Background heartbeat checks | Morpheus has a separate mode for background reasoning and maintenance | No heartbeat runtime | Add heartbeat only after extraction, synthesis, and continuity exist; otherwise it adds complexity without product value | `P2` |

## Recommended Build Focus

If the goal is to make Drost feel meaningfully more alive in the next serious pass, the highest-leverage subset is:

1. Real workspace loader with `AGENTS.md`, `BOOTSTRAP.md`, `TOOLS.md`, `MEMORY.md`, and recent daily memory
2. Layered file-backed memory under `~/.drost/memory`
3. Search/index over both workspace memory files and transcripts
4. Incremental extraction from transcripts into daily notes and entity facts
5. Continuity summaries across new sessions
6. Prompt-time memory capsule and stronger recall instructions

That combination gets Drost much closer to the Morpheus feel without dragging in full graph infrastructure.
