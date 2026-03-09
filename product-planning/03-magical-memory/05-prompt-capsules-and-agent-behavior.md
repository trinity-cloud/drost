# Prompt Capsules And Agent Behavior

## Goal

Make memory visible to the model in the right form before it starts reasoning, without forcing the model to rediscover everything through tools.

This is where the memory system becomes a product feature rather than just a storage system.

## Core Rule

Workspace files are reread and injected on every LLM call.

That already matches the current Drost direction and the reference implementation pattern. The model should not need to explicitly `file_read` core workspace files just to absorb them.

## Prompt Stack

The prompt should include five memory-relevant layers.

### 1. Workspace Identity Layer

Always inject:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`
- `BOOTSTRAP.md` only while bootstrap is active
- `HEARTBEAT.md` only for heartbeat-style runs later

### 2. Recent Daily Memory Layer

Always consider injecting:

- today
- yesterday
- optionally the most recent non-empty day before that if budgets allow

This gives the model a recent-life window without tool calls.

### 3. Continuity Layer

If the session was just created from another session, inject the continuity summary early in the new session.

This should be bounded and clearly marked.

### 4. Ambient Memory Capsule

Before each LLM call, assemble a compact retrieved memory block from the unified index.

Candidate sources:

- top excerpt from `MEMORY.md`
- relevant entity summaries
- relevant recent daily notes
- relevant transcript snippets when needed

The capsule should be deterministic and score-based, not ad hoc free text.

### 5. Directed Memory Tools

If the model needs exact support or more depth, it uses:

- `memory_search`
- `memory_get`

That keeps the base prompt lean while still allowing deep recall.

## Memory Budgeting

Use the user's current target budgeting model as the working default:

- `96K` total context target
- `24K` system/workspace layer target
- `24K` history target
- `24K` memory target
- remaining budget reserved for tools, intermediate state, and variance

These are not hard minimums or hard maximums. They are steering targets.

Implications:

- workspace injection can grow beyond 24K if needed, but should be monitored
- memory capsules should compete for budget rather than always taking the full 24K
- conversation history should slide first before memory quality collapses

## Memory Capsule Assembly Algorithm

Recommended rough order:

1. Start with `MEMORY.md` excerpt if relevant.
2. Add today and yesterday daily files.
3. Add continuity summary if session has a recent handoff.
4. Retrieve top entity summaries by current query.
5. Backfill with transcript snippets only if higher-order memory files are weak.
6. Truncate by section priority, not by blind tail cut.

Priority order:

1. `IDENTITY.md` / `USER.md` / `SOUL.md`
2. `MEMORY.md`
3. continuity summary
4. daily memory
5. entity summaries
6. transcript snippets

## Agent Behavioral Contract

The prompt should instruct the model to behave like this.

### When Ambient Memory Is Enough

If the current prompt already contains the answer, answer directly.

### When Directed Memory Search Is Needed

Use memory tools for:

- dates and timelines
- prior decisions
- people and relationship context
- open project threads
- exact artifact paths or prior commands
- anything the model is not confident about from loaded context

### When To Admit Uncertainty

If neither capsule nor memory tools produce enough support, say so plainly.

That is critical. Magical memory should improve recall, not encourage hallucinated certainty.

## What Not To Do

Do not tell the model to explicitly re-read core workspace memory files on every turn.

That is redundant because the runtime already injects them.

Do not hardcode brittle special cases like:

- "if the user says latest, always call web_search"
- "if the user says remember, always call memory_search"

The system should expose a coherent memory contract and let the model use it flexibly.

## Product Effect

If this is done right, trivial interactions still feel light, but recall-heavy interactions feel much smarter because the right context is already nearby.

That is the actual goal: not more tool calls, but fewer avoidable misses.
