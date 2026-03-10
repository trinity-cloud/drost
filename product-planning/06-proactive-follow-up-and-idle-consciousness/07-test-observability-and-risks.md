# Test, Observability, And Risks

## Test Strategy

### Unit Tests

Cover:

- follow-up lifecycle transitions
- due-window logic
- cooldown logic
- idle state transitions
- dedupe and suppression rules

### Integration Tests

Cover:

- transcript -> follow-up extraction -> stored due item
- idle transition -> heartbeat review -> surfacing decision
- proactive surfacing -> cooldown update -> no duplicate resend
- user reply -> active mode transition -> follow-up resolution path

### Regression Tests

Explicitly add regressions for:

- repeated follow-up spam
- proactive surfacing during active conversation
- vague low-signal items being extracted as follow-ups
- due dates parsed incorrectly
- stale follow-ups resurfacing after completion

## Observability

Recommended metrics:

- `followups_created`
- `followups_deduped`
- `followups_due_now`
- `followups_surfaced`
- `followups_snoozed`
- `followups_completed`
- `idle_mode_entries`
- `idle_heartbeat_runs`
- `idle_heartbeat_noop`
- `idle_heartbeat_surface_decisions`
- `proactive_messages_sent`
- `proactive_messages_suppressed_by_cooldown`

Recommended trace fields:

- current mode (`active` / `idle`)
- matched due items
- decision reason
- confidence
- why an item was suppressed

## Evaluation Questions

Use real-world acceptance questions, not only unit assertions.

Examples:

- did Drost follow up on a concrete prior commitment at the right time?
- did it avoid sending anything when no item was clearly due?
- did it suppress repeated follow-ups after surfacing?
- did it stop proactive behavior immediately when the user re-engaged?

## Main Risks

### 1. Annoyance Risk

This is the biggest risk.

If Drost surfaces too much, the product feeling degrades fast.

Bias hard toward restraint.

### 2. Weak Temporal Extraction

Relative-time references are easy to get wrong.

Examples:

- tomorrow
- next week
- after the meeting

Do not trust weak temporal interpretation blindly.

### 3. Overfitting To Reminder Behavior

The proactive layer should not become a thin reminder app.

It needs to remain contextual and memory-grounded.

### 4. Runtime Complexity Drift

A full loop-manager architecture may come later, but this phase must remain small.

Do not prematurely build:

- general-purpose spawned loops
- full attention allocator
- multi-provider budget scheduler
- event bus abstractions with no current user-facing payoff

### 5. Social Weirdness

Poorly phrased proactive outreach can feel intrusive.

Message style must remain grounded, direct, and concrete.

## Rollout Recommendation

Roll out in three stages:

1. storage + extraction only
2. idle tracking + decision loop without surfacing
3. proactive surfacing with conservative thresholds

That sequence keeps the blast radius contained while still moving directly toward the magical behavior the user actually asked for.
