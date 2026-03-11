# Scheduling, Safety, And Surfacing

## Core Principle

Internal cognition should expand before outward autonomy expands.

That means reflection and drive loops get more freedom to think than to act.

## Priority Order

Recommended runtime priority order:

1. `conversation_loop`
2. `heartbeat_loop` user-visible send step
3. `drive_loop`
4. `reflection_loop`
5. `maintenance_loop`
6. `continuity_worker`

This does not mean reflection or maintenance never run.

It means user-facing responsiveness and bounded proactive behavior remain dominant.

## Surface Rights

### Conversation Loop

May:

- message the user
- use the full normal tool set
- resolve follow-ups
- update shared runtime focus

### Heartbeat Loop

May:

- message the user only when idle and policy allows
- read follow-ups, agenda, and reflections
- snooze or expire due follow-ups

### Reflection Loop

May:

- read bounded context
- write reflection artifacts
- emit internal events

May not:

- message the user
- execute high-impact tools
- write repo or workspace content outside reflection artifacts

### Drive Loop

May:

- read agenda inputs
- write drive-state artifacts
- emit internal events

May not:

- message the user
- perform deploy, shell, or file-write actions outside its own artifacts
- spawn arbitrary external task loops in v1

## Budget Rules

Recommended initial budgets:

- reflection loop: low-frequency, low-token, cheap/standard model tier
- drive loop: moderate frequency, structured output, standard model tier
- heartbeat: small structured decision call, cheap/standard tier
- conversation: frontier/default provider tier as configured by operator

## Anti-Chaos Rules

### Rule 1: Reflection Cannot Self-Escalate To Action

Reflection may emit `reflection_written`, not `take_action_now`.

### Rule 2: Drive Cannot Bypass Heartbeat For User Initiation

If drive believes something deserves surfacing, it should mark:

- `recommended_channel = heartbeat`

Then heartbeat decides if the conditions are actually right.

### Rule 3: Conversation Arrival Suppresses Internal Ambition

When a user arrives:

- conversation wins
- proactive send windows close
- reflection and drive may continue only if cheap and non-disruptive

### Rule 4: Degraded Mode Tightens Permissions

If runtime is degraded:

- heartbeat user-visible surfacing disables
- reflection cadence reduces
- drive loop may still maintain agenda but not escalate new outward candidates

## When Task Loops Should Still Wait

Do not add spawned autonomous task loops in this package unless all of the following are already working well:

- reflections are high quality
- drive state is stable and useful
- proactive behavior is non-annoying
- operator visibility is strong
- internal loops are not causing runtime churn

Until then, the task loop concept should stay planned but unbuilt.
