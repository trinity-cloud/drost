# Test, Observability, And Risks

## Test Strategy

Reflection and drive loops need stronger quality testing than earlier infrastructure-only packages.

The main risk is not just crashes.

The main risk is useless or noisy cognition.

## Required Unit Tests

### Cognitive Artifact Store

- append reflection artifact
- replace drive-state snapshot
- summarize freshness and counts
- recover cleanly after restart

### Reflection Loop

- bounded input assembly
- structured output validation
- empty/no-op reflection handling
- event emission on successful reflection
- no direct user-visible sends

### Drive Loop

- consume reflections and follow-ups into agenda items
- dedupe or merge repeated agenda candidates
- preserve high-priority active agenda items across updates
- no direct user-visible sends

### Prompt Integration

- bounded reflection summary injection
- bounded agenda summary injection
- no raw artifact dump into prompts

### Heartbeat Integration

- drive suggestions influence heartbeat decisions
- heartbeat still refuses to surface while active
- suppressed actions are logged with reason

## Required Integration Tests

- assistant turn completes -> reflection loop runs -> drive loop updates agenda
- follow-up is due -> drive marks it high priority -> heartbeat surfaces only while idle
- user becomes active while reflection/drive are queued -> conversation remains dominant
- restart restores cognitive artifacts and shared mind summaries cleanly

## Observability Additions

Recommended operator surfaces:

- `GET /v1/loops/status`
  - include reflection and drive loop status
- `GET /v1/mind/status`
  - include agenda summary and reflection freshness
- optional future:
  - `GET /v1/cognition/status`

Suggested additional payloads:

- reflection count last 24h
- last reflection timestamp
- last high-importance reflection id
- drive agenda count by status
- top agenda items
- suppressed proactive candidates count

## Key Metrics

Track at minimum:

- reflection runs
- reflection write failures
- reflection no-op rate
- drive runs
- drive agenda item count by kind
- agenda churn rate
- heartbeat decisions influenced by drive state
- proactive suppressions due to active mode
- stale cognition windows

## Main Risks

### 1. Noisy Internal Cognition

Reflection can easily generate shallow or repetitive artifacts.

Mitigation:

- enforce novelty thresholds
- bounded recency windows
- structured output with importance/actionability scores
- skip low-value reflections

### 2. Agenda Churn

The drive loop can create too many constantly-changing priorities.

Mitigation:

- merge similar agenda items
- preserve stable high-priority items
- require review windows before replacing items aggressively

### 3. Prompt Bloat

Injecting raw reflections and agenda state into conversation can drown the user turn.

Mitigation:

- inject only compact summaries
- cap chars and item counts
- prefer relevance-aware rollups

### 4. Hidden Autonomy Creep

Reflection or drive loops may gradually accumulate power they should not yet have.

Mitigation:

- explicit surface-right restrictions
- separate internal artifacts from user-facing actions
- heartbeat remains the outward gate

### 5. Product Weirdness

A system that “thinks” more can also start feeling stranger or more intrusive.

Mitigation:

- conservative proactive policy
- visible operator controls
- log why something was surfaced or suppressed

## Rollout Recommendation

Roll this out behind feature flags.

Suggested flags:

- `DROST_REFLECTION_LOOP_ENABLED`
- `DROST_DRIVE_LOOP_ENABLED`
- `DROST_COGNITIVE_PROMPT_SUMMARIES_ENABLED`

Phase rollout:

1. write artifacts only
2. add internal summaries
3. let heartbeat consult drive state
4. inspect live quality before any further autonomy expansion

## Bottom Line

The success condition is not merely “two more loops are running.”

The success condition is:

- Drost develops useful internal reflections
- Drost maintains a stable internal agenda
- proactive behavior becomes more intelligent without becoming more annoying
