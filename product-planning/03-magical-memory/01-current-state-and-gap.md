# Current State And Gap

## What Drost Has Today

Drost already has the primitives needed for a real memory system:

- dual session transcripts in JSONL
  - user/assistant transcript
  - full transcript with tool calls and tool results
- SQLite persistence with FTS and vector search
- `memory_search` and `memory_get` tools
- prompt assembly that injects workspace files on every LLM call
- seeded workspace contract under `~/.drost`
- timestamped session files and stable session keys

On embeddings specifically, Drost today is still configured around the older OpenAI-style path in `drost/config.py`:

- `memory_embedding_provider = \"openai\"`
- `memory_embedding_model = \"text-embedding-3-small\"`
- `memory_embedding_dimensions = 384`

This is a solid base. The problem is not lack of data. The problem is lack of durable synthesis.

## What reference implementation Does Better

reference implementation is stronger in memory because it layers the system correctly:

1. Workspace files define identity and relationship context.
2. Daily memory files capture recent life and ongoing work.
3. Entity folders hold durable atomic facts and synthesized summaries.
4. A maintenance runner turns fresh transcripts into memory files.
5. A continuity manager carries context between sessions.
6. Prompt assembly injects the right memory slices automatically.

That stack creates the product illusion of a mind that persists.

## Where Drost Falls Short

### 1. Transcript Recall Is Still The Main Memory Path

Drost primarily remembers by searching transcript chunks stored in SQLite. That is useful, but it is not enough.

Problems:

- important facts are buried inside old chat
- there is no durable structured place for people, projects, preferences, or goals
- the agent has to rediscover the same context repeatedly
- new sessions do not inherit distilled carryover

### 2. `MEMORY.md` Exists But Is Not A Real System

`MEMORY.md` is present in the workspace contract, but today it is mostly just a manually editable file.

Missing pieces:

- no automatic updates from transcripts
- no guaranteed indexing parity with transcript memory
- no prompt-time prioritization beyond generic workspace injection
- no relationship to daily memory or entity memory

### 3. No Daily Memory Layer

reference implementation treats today and yesterday as special. Drost currently has the directory scaffolding but no compounding process that fills it.

That means:

- recent personal context is not distilled into a stable daily log
- short-lived but important context can vanish into old transcripts
- the prompt cannot cheaply preload a recent-life slice

### 4. No Durable Entity Memory

There is no canonical place for facts such as:

- who a person is
- what a project is
- what the user prefers
- what changed about an ongoing task

Those facts should not live only in raw chat transcripts.

### 5. No Continuity Across Sessions

Drost creates new sessions correctly, but a new session still starts too cold.

Missing behavior:

- summarize old session into new session
- preserve decisions, constraints, artifacts, and open threads
- reduce the need for the user to restate ongoing work

### 6. No Deterministic Memory Capsule

Drost has ambient transcript retrieval, but not a controlled memory capsule assembled from:

- curated long-term memory
- recent daily notes
- recent continuity
- high-value entity summaries

That is the difference between "I can search" and "I remember the right thing at the right time."

### 7. Embedding Backend Is Not Aligned With The Target Memory System

For the next memory build, the embedding backend should move to Google Gemini.

Why:

- `gemini-embedding-001` is Google's current stable embedding model
- the default full vector is `3072`, which gives us a stronger headroom target than the current `384`
- Google exposes retrieval-specific task types, which maps well to Drost's split between indexed corpus chunks and live user queries

So the memory roadmap should assume:

- provider: Gemini
- model: `gemini-embedding-001`
- auth: `GEMINI_API_KEY`
- dimensions: full default `3072`
- no dimensionality truncation in this pass

## What We Need To Build

The next memory pass needs to deliver four product behaviors.

### Behavior 1: Durable Personal Context

The agent should retain stable knowledge about:

- itself
- the user
- important people
- ongoing projects
- habits and preferences
- recurring goals and routines

### Behavior 2: Recent-Life Awareness

The agent should cheaply recall what has happened recently without searching every transcript.

### Behavior 3: Session Carryover

When the user starts a new session, the agent should begin with enough continuity that the conversation still feels like one relationship.

### Behavior 4: Inspectable Recall

Memory should be auditable from disk:

- Markdown is canonical
- SQLite is the index
- JSONL is the raw event log

That is the right Drost shape. It is transparent, hackable, and still powerful.

## The Core Design Principle

The single most important shift is this:

- transcripts are raw experience
- Markdown memory files are durable memory
- SQLite is the retrieval engine over both

If we keep SQLite as the source of truth, the system stays opaque and brittle.
If we make files the source of truth and SQLite the index, Drost becomes understandable and maintainable.
