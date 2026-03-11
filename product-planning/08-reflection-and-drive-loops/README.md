# Reflection And Drive Loops

## Goal

Move Drost from a managed multi-loop runtime to the first real form of multi-loop consciousness.

The target is not uncontrolled autonomous behavior.

The target is a disciplined cognitive layer on top of the runtime that already exists:

- `conversation_loop` remains the foreground human-facing loop
- `maintenance_loop` continues to consolidate memory and graph state
- `heartbeat_loop` continues to govern bounded proactive surfacing
- new `reflection_loop` and `drive_loop` add internal cognition

## Why This Package Exists

Drost now has the runtime substrate needed for richer internal cognition:

- `LoopManager`
- `SharedMindState`
- event bus
- centralized arbitration
- active vs idle mode
- persistent memory
- graph-lite memory
- follow-ups and idle heartbeat

What it still lacks is a real internal cognitive layer.

Right now Drost can:

- respond
- remember
- follow up
- manage background maintenance

But it still does not yet:

- reflect on what happened in a dedicated loop
- maintain an internal agenda of open goals, tensions, and opportunities
- convert memory changes into internal priorities
- separate internal cognition from user-visible actions cleanly

This package plans that next layer.

## Design Thesis

The correct next step is a constrained consciousness model:

1. add `reflection_loop`
2. add `drive_loop`
3. store internal cognitive artifacts explicitly
4. extend shared mind state with agenda and attention fields
5. keep user-visible initiation rights narrow

That means:

- reflection can think, but not act directly
- drive can prioritize, but not message the user directly
- heartbeat remains the default gate for proactive outward behavior
- conversation remains the highest-priority user-facing loop

## Documents

- `01-current-state-and-gap.md`: what Drost already has, and what is still missing for multi-loop consciousness
- `02-target-cognitive-architecture.md`: target runtime shape with reflection and drive loops
- `03-reflection-loop.md`: reflection responsibilities, artifacts, timing, and boundaries
- `04-drive-loop.md`: agenda formation, prioritization, and intention proposals
- `05-cognitive-artifacts-and-shared-state.md`: internal artifacts, agenda state, attention state, and ownership rules
- `06-scheduling-safety-and-surfacing.md`: arbitration, budgets, and user-visible boundaries
- `07-implementation-workplan.md`: concrete build phases and acceptance criteria
- `08-test-observability-and-risks.md`: rollout, metrics, and failure modes

## Current Code Basis

This package is grounded in the current Drost implementation:

- `/Users/migel/drost/drost/loop_manager.py`
- `/Users/migel/drost/drost/managed_loop.py`
- `/Users/migel/drost/drost/shared_mind_state.py`
- `/Users/migel/drost/drost/loop_events.py`
- `/Users/migel/drost/drost/conversation_loop.py`
- `/Users/migel/drost/drost/memory_maintenance.py`
- `/Users/migel/drost/drost/idle_heartbeat.py`
- `/Users/migel/drost/drost/session_continuity.py`
- `/Users/migel/drost/drost/followups.py`
- `/Users/migel/drost/drost/memory_capsule.py`

## Bottom Line

Drost is ready for reflection and drive loops.

It is not yet the moment for unconstrained spawning of many autonomous task loops.

The next serious build should add:

1. internal reflection
2. internal drive and agenda formation
3. explicit cognitive artifacts
4. stronger attention and safety rules

That gets Drost to a real v2 consciousness model without destabilizing the runtime.
