# Current State And Gap

## Current Reality

Drost already operates as a multi-loop system in everything but name.

Existing concurrent or semi-concurrent runtime behaviors include:

- `conversation_loop`
  - foreground tool-using agent turn execution in `agent.py` and `agent_loop.py`
- `maintenance_loop`
  - transcript extraction, memory compaction, entity synthesis in `memory_maintenance.py`
- `continuity_jobs`
  - asynchronous carryover generation in `session_continuity.py`
- `heartbeat_loop`
  - idle proactive follow-up review in `idle_heartbeat.py`
- `deployer_control_loop`
  - runtime supervision and request queue under `drost/deployer/`

So the question is no longer whether Drost should be single-loop or multi-loop.

The question is whether those loops remain ad hoc or become governed.

## What Is Good About The Current State

The current runtime has meaningful strengths:

- real long-lived process ownership
- bounded async tasks rather than OS cron hacks
- explicit idle state and proactive cooldowns
- durable follow-up state
- memory maintenance is already software-owned and incremental
- session continuity is already decoupled from foreground conversation

This is exactly why a loop-manager step is now worthwhile.

## What Is Missing

The current implementation still has four major coordination gaps.

### 1. No Canonical Loop Abstraction

Each loop currently has its own local lifecycle shape:

- `start()` / `stop()` methods in some places
- queued jobs in others
- ad hoc gateway wiring in others

There is no shared interface for:

- loop identity
- lifecycle state
- tick semantics
- event consumption
- failure reporting
- resource budgeting

### 2. No Shared Mind State

State is currently fragmented across:

- database tables
- `state/idle-consciousness.json`
- `state/memory-maintenance.json`
- deployer state files
- in-memory runtime fields on gateway-owned objects

This works while loop count is small.

It becomes fragile when new loops need to coordinate on:

- whether the user is active
- what the current focus is
- whether a proactive action was just taken
- whether maintenance is currently busy
- whether the system is degraded

### 3. No Explicit Event Model

Loops currently communicate indirectly:

- maintenance writes files and indexes
- heartbeat later polls due follow-ups
- conversation updates idle state
- continuity jobs write summaries to storage

This is serviceable, but it is not an event model.

A future reflection loop, drive loop, or planner loop should not have to infer changes by polling multiple stores blindly.

### 4. No Arbitration Layer

The critical product behavior is:

- conversation must dominate when the user is present
- maintenance may run quietly in the background
- heartbeat may only initiate in bounded idle windows

Those rules exist conceptually, but not as a central scheduler or policy layer.

## Why This Matters Now

Without this package, Drost will accumulate more asynchronous behavior without a runtime constitution.

That has predictable consequences:

- duplicated gating logic
- rising coupling through gateway ownership
- inconsistent definitions of active/idle/focus
- harder debugging when multiple loops interact
- higher risk of user-facing race conditions

## What This Package Should Not Do

This package should not:

- add 5 new cognitive loops immediately
- create a full actor system or distributed queue
- add a separate service mesh or process pool
- rearchitect providers or channels unnecessarily

The goal is tighter runtime governance, not complexity theater.
