# Target Cognitive Architecture

## Core Design

Add two new managed loops on top of the existing managed runtime:

- `reflection_loop`
- `drive_loop`

Recommended target shape:

```text
Gateway
  -> LoopManager
       -> conversation_loop
       -> maintenance_loop
       -> heartbeat_loop
       -> continuity_worker
       -> reflection_loop
       -> drive_loop
       -> shared_mind_state
       -> event_bus
       -> cognitive_artifact_store
```

## Loop Roles

### Conversation Loop

Purpose:

- handle live user-facing turns
- update focus and active state
- emit conversation completion signals

Properties:

- highest priority
- user-visible
- can suppress proactive behavior immediately

### Maintenance Loop

Purpose:

- compound durable memory
- update graph-lite memory
- synthesize entity summaries and follow-ups

Properties:

- background only
- not user-visible
- periodic plus event-driven

### Heartbeat Loop

Purpose:

- decide whether a proactive user-visible message is warranted
- surface, snooze, or expire due follow-ups
- remain the gate for proactive outward behavior

Properties:

- user-visible only when policy allows
- idle-only for outward behavior
- bounded and rate-limited

### Reflection Loop

Purpose:

- interpret recent experience
- consolidate tensions, themes, and unresolved questions
- produce cognitive reflections and candidate insights

Properties:

- internal only
- no direct user messaging
- no direct high-impact tool execution
- event-driven plus low-frequency periodic review

### Drive Loop

Purpose:

- transform follow-ups, reflections, memory updates, and unresolved threads into an internal agenda
- prioritize what matters now, later, or not at all
- prepare candidate intentions for heartbeat or future task systems

Properties:

- internal only in v1
- no direct user messaging
- no autonomous tool side effects in v1
- reads many internal artifacts, writes structured agenda state

## Shared Mind Evolution

`SharedMindState` must evolve from pure runtime coordination into a lightweight cognitive coordination layer.

It should still avoid becoming long-term memory.

It should now additionally track:

- current attention focus
- current agenda summary
- recent reflections summary
- current drive priorities
- which internal loops are busy or stale
- whether a user-visible proactive action is being considered or suppressed

## Why This Architecture Is Right

This architecture creates a clean separation:

- memory stores what happened
- reflection interprets what happened
- drive prioritizes what to care about
- heartbeat decides whether anything should reach the user
- conversation handles the user directly

That separation is the real win.

It avoids making every loop do everything.
