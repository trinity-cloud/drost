# Loop Manager And Shared Mind State

## Goal

Turn Drost's existing independent background runners into a coherent managed multi-loop runtime.

The target is not a science-fiction consciousness simulator.

The target is a disciplined runtime core that can:

- manage multiple loops with explicit priorities
- share runtime state across those loops without ad hoc coupling
- arbitrate which loops may act when the user is active or idle
- keep proactive behavior bounded and inspectable
- create the foundation for later reflection or drive loops without rewriting the system again

## Why This Package Exists

Drost already has multiple loops in practice:

- the foreground conversation loop
- the memory maintenance loop
- session continuity jobs
- the idle heartbeat / proactive follow-up loop

That means the next architectural problem is no longer “should Drost have multiple loops?”

It already does.

The real problem is that those loops are currently coordinated informally:

- separate async tasks
- separate state files
- direct gateway ownership
- no shared scheduler or arbitration layer
- no explicit event model
- no unified notion of focus, idle state, or loop health

If Drost keeps adding loops this way, complexity will drift quickly.

## Design Thesis

The correct next step is not adding more cognitive loops first.

The correct next step is:

1. define a `LoopManager`
2. define canonical `SharedMindState`
3. define loop contracts and event flow
4. migrate the existing loops under that manager
5. only then add new loops such as reflection or drive

This package therefore plans a managed 3-loop core first:

- `conversation_loop`
- `maintenance_loop`
- `heartbeat_loop`

## Documents

- `01-current-state-and-gap.md`: what Drost already has, and where coordination is still implicit
- `02-target-runtime-architecture.md`: target managed runtime shape
- `03-shared-mind-state.md`: canonical shared state model and ownership rules
- `04-loop-contracts-and-event-bus.md`: how loops communicate without direct coupling
- `05-scheduling-priorities-and-arbitration.md`: who runs when, who wins, and why
- `06-implementation-workplan.md`: concrete migration sequence and acceptance criteria
- `07-test-observability-and-risks.md`: rollout, metrics, and failure modes

## Current Code Basis

This package is grounded in the current Drost implementation:

- `/Users/migel/drost/drost/agent.py`
- `/Users/migel/drost/drost/agent_loop.py`
- `/Users/migel/drost/drost/gateway.py`
- `/Users/migel/drost/drost/memory_maintenance.py`
- `/Users/migel/drost/drost/session_continuity.py`
- `/Users/migel/drost/drost/idle_heartbeat.py`
- `/Users/migel/drost/drost/idle_state.py`
- `/Users/migel/drost/drost/followups.py`
- `/Users/migel/drost/drost/deployer/`

## Bottom Line

Drost is now ready for managed multi-loop infrastructure.

It is not yet the moment for unconstrained loop proliferation.

The next serious build should establish a narrow runtime core that can safely own:

1. user conversation
2. background maintenance
3. bounded proactive heartbeat

Once that is stable, richer reflection and drive loops become a justified next step instead of an architectural gamble.
