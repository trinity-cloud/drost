# Test, Observability, And Risks

## Testing Strategy

## Reflection Hygiene Tests

- repeated idle events do not append reflections
- skip counters increment correctly
- real novelty still produces reflection artifacts

## Heartbeat Hygiene Tests

- heartbeat honors drive channel hints
- trivial noops are aggregated or downgraded correctly
- meaningful suppressions remain fully auditable
- proactive sends still produce full audit rows

## Memory Promotion Tests

- stable repeated facts promote
- one-off facts do not promote
- canonical file sections are updated deterministically
- promotion dedupe works

## Deploy Canary Tests

- health-only pass but provider/tool failure triggers rollback
- canary failure labels are preserved
- known-good tracking remains correct after rollback

## Live Validation

Run live canaries after each subphase:

1. reflection idle soak
2. heartbeat idle soak
3. promotion review on real transcripts
4. deploy canary on a harmless candidate restart

## Operator Surfaces To Add Or Tighten

Recommended additions:

- reflection skip counters in loop status
- heartbeat aggregate noop counters
- promotion journal endpoint/status
- deploy canary phase/result in deployer status
- quality gate status endpoint

## Key Metrics

### Reflection

- writes per hour
- skips per hour
- write/skip ratio
- duplicate-theme streaks

### Heartbeat

- meaningful decisions per hour
- trivial noops per hour
- proactive sends per day
- suppressions by reason

### Promotion

- candidates proposed
- promotions accepted
- promotions rejected
- human-reviewed precision rate

### Deployer

- canary pass rate
- rollback rate
- rollback success rate
- time to classify failure

## Main Risks

### Risk 1: Over-Suppression

If reflection and heartbeat become too aggressive about skipping:

- Drost may look quieter but actually become less useful

Mitigation:

- preserve metrics
- keep meaningful-path tests
- review live traces

### Risk 2: Promotion Pollution

If promotion thresholds are too loose:

- canonical memory files become noisy and untrustworthy

Mitigation:

- machine-owned sections
- promotion journal
- repeated-evidence thresholds

### Risk 3: Deploy Canary Flakiness

If canaries are too broad or too network-sensitive:

- deployer becomes brittle

Mitigation:

- keep canaries deterministic and cheap
- separate local-runtime checks from remote-provider checks clearly

### Risk 4: Operator Surface Bloat

If every new signal is exposed at top level:

- status endpoints become unreadable

Mitigation:

- summary vs detail separation
- bounded tails
- dedicated quality-gate surface

## Success Signal

This package succeeds if operators can say:

- reflections are rarer and better
- heartbeat is quieter and clearer
- canonical memory files became more valuable
- deploy promotion feels safer
- the system earned the right to the next cognition package
