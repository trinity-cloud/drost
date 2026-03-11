# Memory Promotion Layer

## Problem

Drost has strong memory infrastructure, but still lacks the layer that turns repeated observations into durable canonical workspace memory.

That is the main missing piece between:

- rich retrieval

and

- truly magical continuity

## Goal

Create a software-owned promotion pipeline into:

- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`

These files should become the durable distilled core of the relationship and the agent.

## Promotion Targets

### `USER.md`

Should hold:

- stable preferences
- communication style preferences
- recurring goals
- recurring constraints
- standing personal context that helps future turns

Examples:

- prefers direct mechanistic explanations
- wants aggressive but rigorous execution
- cares about hormone / bloodwork interpretation quality

### `IDENTITY.md`

Should hold:

- stable role definition of Drost
- standing commitments about how Drost behaves
- identity changes that are truly durable

Examples:

- Drost is a supervised personal agent, not a chat assistant
- Drost should use deployer tools instead of shell for lifecycle control

### `MEMORY.md`

Should hold:

- stable shared context that is neither purely user nor purely agent identity
- standing projects
- durable facts that matter across sessions

Examples:

- main repo path
- major ongoing product threads
- persistent operational constraints

## Non-Goals

Do not promote:

- one-off details
- transient emotions
- speculative interpretations
- ephemeral task state
- routine conversation summaries

Those belong in:

- transcripts
- daily memory
- entity files
- continuity

## Proposed Promotion Pipeline

### Step 1: Candidate Extraction

During maintenance, extract `promotion_candidates` alongside facts/follow-ups.

Each candidate should include:

- `target_file`: `USER.md|IDENTITY.md|MEMORY.md`
- `candidate_text`
- `kind`
- `confidence`
- `stability`
- `evidence_refs`
- `why_promotable`

### Step 2: Deterministic Deduping

Before writing:

- normalize whitespace
- compare against existing canonical entries
- compare against recent promotion candidates
- suppress near-duplicates

### Step 3: Write Into Managed Sections

Do not let the model rewrite whole files freely.

Instead, maintain explicit machine-owned sections inside each file:

```md
## Machine-Promoted
- ...
```

and keep room for human-edited sections above/below.

That avoids destructive file churn.

### Step 4: Promotion Journal

Write a promotion journal under `~/.drost/state/`:

- `promotion-decisions.jsonl`

Each row should record:

- candidate
- target file
- accepted / rejected
- reason
- evidence refs

## Promotion Thresholds

Only promote when at least one is true:

- repeated across sessions
- repeated across days
- explicitly stated as durable
- directly affects future response quality
- directly affects agent behavior expectations

## Promotion Cadence

Recommended:

- maintenance proposes candidates incrementally
- promotion pass runs less frequently than raw maintenance
- e.g. every few hours or once daily

That keeps promotion thoughtful instead of twitchy.

## Interaction With Reflection And Drive

Promotion should be informed by:

- reflection artifacts
- drive priorities
- transcript evidence
- graph/entity persistence

But promotion itself should remain a separate bounded step.

Do not let reflections directly rewrite canonical memory files.

## Acceptance Criteria

- `USER.md`, `IDENTITY.md`, and `MEMORY.md` accumulate real durable value
- promoted entries are stable and low-noise
- operator can inspect promotion decisions
- prompt quality improves because core durable context becomes stronger
