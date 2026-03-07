# Test Observability And Risks

## Test Strategy

## Unit Tests

### File Model

Test:

- daily note append behavior
- entity fact append behavior
- duplicate suppression for exact fact duplicates
- stable fact ID generation
- workspace bootstrap convergence for `memory/` and `state/`

### Indexing

Test:

- indexing of `MEMORY.md`
- indexing of daily files
- indexing of entity `items.md`
- indexing of entity `summary.md`
- rebuild behavior from disk
- path and line metadata correctness
- Gemini document embeddings use `gemini-embedding-001`
- query embeddings use retrieval-query mode
- stored vectors are `3072` dimensions
- `GEMINI_API_KEY` wiring is respected

### Tools

Test:

- `memory_search` returns source-kind-aware results
- `memory_get` reads workspace paths correctly
- `memory_get` reads transcript slices correctly
- backwards compatibility for legacy IDs during migration

### Maintenance

Test:

- cursor advancement
- transcript shrink/rotation handling
- extraction parse failure behavior
- duplicate fact suppression
- synthesis cadence gating

### Continuity

Test:

- `/new` session handoff path
- bounded summary injection
- repeated continuity summaries are not recursively re-summarized
- manager failure does not break session creation

### Prompt Capsules

Test:

- capsule section ordering
- budget trimming by priority
- continuity inclusion when present
- no explicit re-read instructions for already injected workspace files

## Integration Tests

Build scripted conversations that prove real product lift.

### Scenario 1: Personal Preference Recall

- user states a preference
- maintenance runs
- later session asks about it
- agent recalls via memory file or capsule, not raw transcript luck

### Scenario 2: Ongoing Project Continuity

- user and agent make several architecture decisions
- `/new` session starts
- continuity summary lands
- agent continues without asking the user to restate everything

### Scenario 3: Exact Artifact Recall

- agent creates a file or runs a command
- maintenance extracts the artifact fact
- later ask for the path or command
- retrieval returns exact support

### Scenario 4: Daily Context Recall

- user mentions multiple same-day updates
- daily file is created
- later the same day the agent answers with recent context loaded

## Observability

## Logs

Add structured logs for:

- memory extraction runs
- extracted bullet count
- extracted fact count
- touched files
- reindex count
- embedding provider/model/dimensions
- continuity jobs queued/completed/failed
- capsule source selection and token counts

## State Inspection

Expose runtime-inspectable state via files and gateway routes where useful.

Candidates:

- `GET /v1/memory/status`
- `GET /v1/memory/maintenance/status`
- `GET /v1/memory/continuity/status`

## JSONL And Trace Parity

Keep using the existing dual transcript model.

That gives three levels of truth:

- user/assistant transcript for the conversation the user saw
- full transcript for tool/debug detail
- memory files for durable synthesis

This is a strong design. Keep it.

## Major Risks

### 1. Noisy Memory Pollution

If extraction is too eager, memory files fill with trivia.

Mitigation:

- bias toward durable facts
- keep daily notes short
- synthesize weekly instead of constantly rewriting

### 2. Duplicate Fact Explosion

If the same fact is extracted repeatedly, `items.md` becomes unusable.

Mitigation:

- exact duplicate suppression first
- optional lightweight near-duplicate check later
- summary generation should smooth mild duplication

### 3. Retrieval Ranking Regressions

Once workspace memory enters the index, transcript hits and durable memory hits may compete badly.

Mitigation:

- store `source_kind`
- measure result mix
- tune rank fusion weights with real transcript fixtures

### 4. Embedding Migration Drift

If the runtime keeps half-migrated assumptions from the old embedding path, the memory index will get brittle fast.

Examples:

- some rows at `384`, some at `3072`
- document and query embeddings produced with mismatched task types
- fallback behavior silently degrading into deterministic local vectors

Mitigation:

- one canonical embedding model: `gemini-embedding-001`
- one canonical vector size: `3072`
- explicit migration or rebuild path for index shape changes
- loud logs when Gemini auth is missing or embedding calls fail

### 5. Prompt Bloat

If workspace files, daily notes, continuity, and retrieved memory all pile in, prompt quality will degrade.

Mitigation:

- section priority trimming
- explicit budget ownership
- deterministic capsule ordering

### 6. Opaque Automation

If maintenance writes memory files in surprising ways, users will stop trusting the system.

Mitigation:

- keep Markdown readable
- add stable file formats
- log changed files and counts
- never make SQLite the only place meaning lives

### 7. Over-Porting Morpheus

Drost does not need every Morpheus subsystem.

Mitigation:

- no graph database in this pass
- no extra channels in this pass
- no hidden internal memory abstractions beyond what files and SQLite already justify

## Recommendation

Success for this package is not "largest possible memory system."

Success is:

- the user can inspect the workspace and understand memory
- the agent recalls better across days and sessions
- continuity improves materially
- the implementation stays lean enough that Drost still feels like Drost
