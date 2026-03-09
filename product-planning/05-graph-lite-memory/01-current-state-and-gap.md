# Current State And Gap

## What Drost Already Has

Drost already has the first generation of durable memory:

- `MEMORY.md` as curated top-level memory
- `memory/daily/YYYY-MM-DD.md` for day-level accumulation
- `memory/entities/<type>/<id>/items.md` for atomic facts
- `memory/entities/<type>/<id>/summary.md` for synthesized summaries
- session continuity artifacts
- prompt-time memory capsules
- unified SQLite search across transcripts and workspace memory files

This is a real system. It is no longer transcript-only recall.

## What Is Missing

The missing capability is structure across entities.

Today Drost can remember:

- that a fact exists
- that a summary exists
- that a session carried forward specific context

But it does not explicitly know:

- that `Migel` is the owner of `Drost`
- that `Drost` depends on `Anthropic`, `OpenAI Codex`, `xAI`, `Gemini embeddings`, and the `deployer`
- that a user preference is tied to a specific workflow or project
- that a repo path, bot identity, deployer, and workspace are all facets of the same project context
- that two names or aliases refer to the same entity

That creates quality problems.

## Practical Failures Without Graph-Lite Memory

### 1. Entity Fragmentation

The same thing can be remembered under multiple surfaces:

- `Drost`
- `the repo`
- `/Users/migel/drost`
- `the agent`
- `the Telegram bot`

Without explicit aliasing and entity resolution, these memories stay loosely related instead of being compoundable.

### 2. Weak Relationship Recall

Drost can retrieve a fact that mentions a project and a user, but cannot reliably answer relationship-heavy questions such as:

- who owns this system?
- what components are part of the deploy path?
- what constraints apply to source-code edits versus workspace files?
- how is a given provider used inside the stack?

### 3. Preference Drift

Some preferences are not standalone facts. They are relationships:

- user prefers direct answers
- user wants all permissions for file access
- source code should be handled more carefully than workspace files
- deploy actions should go through the deployer, not ad hoc shell commands

These need to bind to user identity, project identity, and operating domains.

### 4. Poor Neighborhood Recall

If the model retrieves `Drost` summary, it should also be able to recall nearby context:

- owner
- deployer
- workspace
- Telegram bot
- providers
- memory stack

Current retrieval treats these as mostly separate snippets.

### 5. Weak Temporal Reasoning

Facts change over time. Relationships change over time too.

Examples:

- active provider changed
- startup path changed from direct gateway to supervised deployer
- specific operating constraints were clarified in one session and superseded later

A flat fact pile does not model this cleanly.

## Target Product Effect

Graph-lite memory should make Drost feel like it has a connected world model, not just good search.

Desired improvements:

- better disambiguation of repeated names and paths
- stronger continuity over long-running projects
- better recall of user preferences and constraints in the right context
- fewer redundant tool calls to rediscover context
- better answer quality for "how are these things connected?" questions

## What Graph-Lite Means Here

Graph-lite does not mean a new standalone graph database.

It means:

- file-backed entity and relation records under `~/.drost`
- deterministic alias and relation handling
- derived SQLite tables and search rows for ranking and retrieval
- one-hop and two-hop neighborhood awareness during memory capsule assembly

That is enough to move quality materially without introducing operational drag.
