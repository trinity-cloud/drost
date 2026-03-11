# Target Quality Architecture

## Objective

Keep the current runtime architecture.

Improve the quality of what it writes, surfaces, promotes, and trusts.

This package is therefore a quality architecture package, not a subsystem expansion package.

## Target Runtime Shape

After this package, the runtime should look like this:

1. `reflection_loop`
- runs less often in substance
- writes only when there is net-new value
- records "skipped" decisions without polluting artifact history

2. `drive_loop`
- continues to build agenda
- benefits from cleaner reflection input
- no major architectural change in this package

3. `heartbeat_loop`
- consumes drive and reflection context
- produces fewer but more legible audit records
- surfaces only meaningful proactive actions

4. `memory_maintenance`
- continues transcript-to-memory extraction
- gains a promotion path into canonical workspace files

5. `deployer`
- validates more than process liveness
- promotes only after a stronger runtime canary

## New Architectural Principle

Distinguish four kinds of runtime outputs:

1. **Canonical**
- durable files the agent relies on long term
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`

2. **Derived**
- useful but replaceable outputs
- `daily/*.md`
- entity summaries
- drive state
- attention state

3. **Ephemeral**
- event bus chatter
- interval skips
- transient runtime counters

4. **Audit**
- logs that justify decisions
- heartbeat decision journal
- deploy canary results
- promotion decisions

Right now Drost blurs `derived` and `audit` too often.

This package should sharpen those boundaries.

## Target Quality Rules

### Reflection Rule

Do not write a reflection artifact unless at least one is true:

- novel change detected
- contradiction detected
- cross-thread synthesis detected
- unresolved tension sharpened
- useful follow-up or agenda shift created

Otherwise:

- record a cheap skip status
- do not append to `reflections.jsonl`

### Heartbeat Rule

Do not emit a full audit/event record for every routine `tick -> interval_not_elapsed`.

Instead:

- aggregate trivial skips
- preserve full records for:
  - actual proactive sends
  - provider decisions
  - suppressions tied to cognitive or policy reasons
  - canary-relevant failures

### Promotion Rule

Do not promote one-off facts into canonical memory files.

Only promote:

- stable preferences
- durable constraints
- repeated standing facts
- long-lived identity/relationship context

### Deploy Rule

Do not promote a candidate runtime to known-good until:

1. process is healthy
2. gateway responds
3. provider round-trip works
4. tool round-trip works
5. core runtime surfaces respond

### Cognition Gate Rule

Do not add the next cognition package until:

- reflection skip rate is healthy
- heartbeat noise is materially reduced
- memory promotion is landing useful durable context
- deploy canary is stronger than `/health`

## Desired End State

Drost should feel:

- calmer
- more selective
- more stable
- more durable in what it remembers
- safer in how it evolves
