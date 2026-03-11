# Rollout And Quality Gates

## Principle

Do not attack all five quality problems at once.

Sequence them so each step improves the next:

1. reflection hygiene
2. heartbeat hygiene
3. memory promotion
4. stronger deploy canary
5. explicit cognition gate

## Phase 1: Reflection Hygiene

### Build

- reflection `write` vs `skip` contract
- deterministic prefilters
- skip counters instead of artifact churn

### Acceptance

- long idle stretches no longer append repetitive reflections
- reflection artifact rate drops materially

## Phase 2: Heartbeat Hygiene

### Build

- richer decision classes
- cognitive suppression reasons
- aggregate trivial noops
- cleaner audit/event policy

### Acceptance

- recent heartbeat trail is readable
- low-value noise is reduced

## Phase 3: Memory Promotion

### Build

- promotion candidate extraction
- promotion journal
- managed machine-written sections in canonical files

### Acceptance

- `USER.md`, `IDENTITY.md`, and `MEMORY.md` gain durable value
- promotion noise stays low

## Phase 4: Deploy Canary

### Build

- runtime surface canaries
- provider canary
- tool canary
- clearer deploy failure labels

### Acceptance

- deployer can detect runtime-broken-but-alive states

## Phase 5: Quality Gate

### Build

- define explicit thresholds
- expose them in operator status
- make them the gating condition for the next cognition package

### Proposed Gates

- reflection skip ratio above target in quiet periods
- heartbeat meaningful-decision ratio above target
- promotion precision acceptable after live review
- deploy canary pass rate high enough over recent deploys

## Explicit "Do Not Proceed" Rule

Do not start the next cognition package until:

1. reflection hygiene is clearly improved
2. heartbeat noise is clearly reduced
3. promotion produces useful durable memory
4. stronger deploy canary is live

If those are not true, the correct move is tuning, not expansion.
