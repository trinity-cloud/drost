# Scheduling, Priorities, And Arbitration

## Core Principle

The multi-loop runtime must behave as if it has a constitution.

The most important rule is simple:

- foreground conversation wins

Everything else follows from that.

## Priority Model

Recommended priority order:

1. `conversation_loop`
2. `heartbeat_loop` user-visible send step
3. `maintenance_loop`
4. `continuity_jobs`

This does not mean maintenance or heartbeat never run.

It means the runtime has explicit rules when pressure or concurrency increases.

## Arbitration Rules

### Rule 1: User Presence Dominates

If a user message arrives:

- runtime enters active mode immediately
- proactive user-visible heartbeat actions are suppressed
- maintenance may continue only if non-disruptive

### Rule 2: Heartbeat May Initiate Only While Idle

Heartbeat may review at any time if cheap, but it may only send user-visible messages when:

- mode is idle
- cooldown has elapsed
- no foreground conversation turn is in progress

### Rule 3: Maintenance Never Initiates

Maintenance may emit events and write memory, but it may not directly message the user.

This keeps role boundaries clear.

### Rule 4: Continuity Is Opportunistic

Continuity jobs should not block user-facing conversation unless explicitly requested.

### Rule 5: Degraded Mode Tightens Permissions

If the runtime is degraded:

- proactive initiation should disable automatically
- maintenance may reduce cadence
- operator visibility should increase

## Tick And Event Strategy

Recommended v1 behavior:

- conversation loop: pure event-driven
- maintenance loop: hybrid event-driven plus periodic
- heartbeat loop: hybrid event-driven plus periodic

The important point is not strict purity.

The important point is that timing behavior is owned centrally and inspectably.

## Anti-Spam Arbitration

The runtime should explicitly prevent these failure modes:

- multiple proactive sends in quick succession
- heartbeat sending during active conversation
- maintenance indirectly triggering repeated heartbeat sends
- overlapping heartbeat decisions for the same follow-up

This implies:

- per-loop run locks
- per-follow-up suppression
- shared proactive cooldown in shared mind state
- single-flight guarantee for heartbeat send actions

## Why This Matters

Without clear arbitration, multi-loop architecture becomes user-hostile fast.

The product goal is not “many things happening.”

The product goal is:

- responsiveness when the user is present
- thoughtful background cognition when the user is away
- no confusing collisions between them
