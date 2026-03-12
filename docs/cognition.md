# Cognition

Drost's cognitive layer is a background pipeline that gives the agent internal context between conversations. Instead of treating each message as stateless input, Drost continuously reflects on recent experience, maintains a self-updating agenda, and uses that internal state to make better decisions about when and how to act.

## Pipeline

The cognitive layer is a chain of event-driven loops:

```
Conversation → Reflection → Drive → Heartbeat
     │              │          │         │
     │              │          │         └── Uses agenda + reflections to decide
     │              │          │             whether a follow-up is worth surfacing
     │              │          │
     │              │          └── Synthesizes reflections + follow-ups into
     │              │              an internal agenda (max 5 active items)
     │              │
     │              └── Generates internal reflections from recent transcript
     │                  (pattern, tension, insight, unresolved, identity_shift)
     │
     └── User ↔ Agent conversation (triggers downstream loops via events)
```

Each stage subscribes to events from upstream stages and writes artifacts that downstream stages consume. The pipeline runs automatically — no user interaction required.

## Reflection Loop

The reflection loop generates bounded internal observations from recent conversation transcripts.

**Trigger events**: `assistant_turn_completed`, `memory_maintenance_completed`, `followup_created`, `followup_updated`, `continuity_written`

**What it does**:
1. Loads the most recent transcript from the active session JSONL
2. Fingerprints the transcript to avoid re-reflecting on unchanged input
3. Builds a system prompt including SOUL.md, IDENTITY.md, USER.md, MEMORY.md
4. Asks the LLM to either `write_reflections` or `skip_reflection`
5. Stores accepted reflections in `state/reflections.jsonl`
6. Emits `reflection_written` to trigger downstream loops

**Reflection kinds**:
- `pattern` — recurring behavior or theme
- `tension` — conflicting signals or unresolved friction
- `insight` — novel understanding worth preserving
- `unresolved` — open question the agent can't yet answer
- `identity_shift` — change in how the agent understands itself or the user

**Each reflection carries**:
- `importance`, `novelty`, `actionability` scores (0.0–1.0)
- `suggested_drive_tags` for downstream agenda synthesis
- `evidence` references to source material

**Quality tracking**: The loop tracks `write_count`, `skip_count`, and `consecutive_skip_count`. The quality gates system uses the skip ratio to determine whether the reflection loop is appropriately selective.

## Drive Loop

The drive loop maintains Drost's internal agenda — a ranked list of what the agent currently cares about.

**Trigger events**: `reflection_written`, `followup_created`, `followup_updated`, `memory_maintenance_completed`, `continuity_written`

**What it does**:
1. Loads recent reflections, relevant follow-ups, and current drive state
2. Asks the LLM to produce an updated agenda
3. Writes the result to `state/drive-state.json` and `state/attention-state.json`
4. Emits `drive_updated`

**Agenda item kinds**:
- `goal` — something the agent is actively working toward
- `responsibility` — ongoing obligation
- `opportunity` — potential action worth considering
- `open_thread` — unfinished conversation or task
- `concern` — risk or issue to monitor

**Each item carries**:
- `priority`, `urgency`, `confidence` scores (0.0–1.0)
- `recommended_channel`: `heartbeat` (proactive surfacing OK), `conversation_only` (wait for user), or `hold` (suppress)
- `source_refs` linking back to reflections, follow-ups, or other artifacts

**Constraints**: Maximum 5 active items. The LLM is instructed to preserve stable items rather than churning, and to keep the agenda small when there's little to care about.

## Attention State

The attention state is a lightweight snapshot of where the agent's focus currently sits:

- `current_focus_kind` — `reflection`, `drive`, or `conversation`
- `current_focus_summary` — short description of current focus
- `top_priority_tags` — tags from the highest-priority agenda items
- `reflection_stale` / `drive_stale` — flags indicating whether cognitive state needs refresh

Written to `state/attention-state.json` by both the reflection and drive loops.

## Cognitive Summary (Prompt Injection)

At conversation time, the `CognitiveSummaryBuilder` selects the most relevant reflections and agenda items to inject into the system prompt.

**Ranking**:
- Reflections scored by: `importance * 0.012 + actionability * 0.010 + novelty * 0.004 + lexical_overlap * 0.018`
- Agenda items scored by: `priority * 0.012 + urgency * 0.010 + confidence * 0.006 + lexical_overlap * 0.020`

**Selection**: Prefers items with lexical overlap against the current user message. Falls back to highest-scored items.

**Output sections**:
- `[Recent Reflections]` — up to 2 relevant reflections
- `[Current Internal Agenda]` — up to 3 relevant agenda items
- `[Attention Tags]` — top priority tags from attention state

**Budget**: Half of `context_budget_memory_tokens`, capped at 1200 tokens.

## Memory Promotion

The memory promotion system graduates stable facts from cognitive artifacts and daily memory into permanent workspace files.

**Targets**: `USER.md`, `IDENTITY.md`, `MEMORY.md`

**How it works**:
1. During memory maintenance, the LLM evaluates candidates for promotion
2. Candidates must exceed `memory_promotion_confidence_threshold` (default 0.90) and `memory_promotion_stability_threshold` (default 0.85)
3. Accepted entries are written into a `<!-- drost:machine-promoted:start/end -->` section in the target file
4. All decisions (accepted and rejected) are journaled in `state/promotion-decisions.jsonl`
5. Entries are deduplicated by normalized text and sorted by kind

**Entry format** in workspace files:
```markdown
## Machine-Promoted
<!-- drost:machine-promoted:start -->
- [preference] User prefers direct answers without hedging
- [fact] User's timezone is US/Pacific
<!-- drost:machine-promoted:end -->
```

## Quality Gates

The quality gates system evaluates whether the cognitive layer is performing well enough to advance to the next cognition package.

**4 gates**:

| Gate | Metric | Pass condition |
|---|---|---|
| `reflection_hygiene` | skip ratio | >= 0.60 (loop is selective, not writing on every trigger) |
| `heartbeat_hygiene` | meaningful ratio | >= 0.20 (heartbeat makes real decisions, not just noise) |
| `promotion_precision` | operator review | Approved by operator on live samples |
| `deploy_canary` | recent canary pass rate | >= 0.66 with >= 2 consecutive OK |

**Endpoints**:
- `GET /v1/quality/status` — full gate status with metrics
- `POST /v1/quality/promotion-review` — operator approves/rejects promotion precision

**State file**: `state/quality-gates.json`

## Artifacts and State Files

| File | Format | Written by |
|---|---|---|
| `state/reflections.jsonl` | JSONL | Reflection loop |
| `state/drive-state.json` | JSON | Drive loop |
| `state/attention-state.json` | JSON | Reflection loop, Drive loop |
| `state/promotion-decisions.jsonl` | JSONL | Memory maintenance (promotion) |
| `state/quality-gates.json` | JSON | Quality gate store |
| `state/heartbeat-decisions.jsonl` | JSONL | Heartbeat loop |

## Event Flow

```
assistant_turn_completed ──→ reflection_loop
                              │
                              ├── reflection_written ──→ drive_loop
                              │                           │
                              │                           └── drive_updated
                              │
followup_created/updated ──→ reflection_loop, drive_loop, heartbeat_loop
memory_maintenance_completed → reflection_loop, drive_loop
continuity_written ──────────→ reflection_loop, drive_loop
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DROST_QUALITY_REFLECTION_MIN_SAMPLES` | 5 | Minimum reflection decisions before gate evaluates |
| `DROST_QUALITY_REFLECTION_SKIP_RATIO_THRESHOLD` | 0.60 | Skip ratio required for reflection hygiene pass |
| `DROST_QUALITY_HEARTBEAT_MIN_SAMPLES` | 3 | Minimum meaningful heartbeat decisions before gate evaluates |
| `DROST_QUALITY_HEARTBEAT_MEANINGFUL_RATIO_THRESHOLD` | 0.20 | Meaningful ratio required for heartbeat hygiene pass |
| `DROST_QUALITY_DEPLOY_CANARY_RECENT_WINDOW` | 3 | Number of recent canary events to evaluate |
| `DROST_QUALITY_DEPLOY_CANARY_MIN_SAMPLES` | 3 | Minimum canary events before gate evaluates |
| `DROST_QUALITY_DEPLOY_CANARY_PASS_RATE_THRESHOLD` | 0.66 | Canary pass rate required |
| `DROST_QUALITY_DEPLOY_CANARY_CONSECUTIVE_OK_THRESHOLD` | 2 | Consecutive healthy canaries required |
| `DROST_MEMORY_PROMOTION_ENABLED` | true | Enable memory promotion |
| `DROST_MEMORY_PROMOTION_INTERVAL_SECONDS` | 21600 | Minimum interval between promotion runs |
| `DROST_MEMORY_PROMOTION_CONFIDENCE_THRESHOLD` | 0.90 | Confidence required for promotion |
| `DROST_MEMORY_PROMOTION_STABILITY_THRESHOLD` | 0.85 | Stability required for promotion |
