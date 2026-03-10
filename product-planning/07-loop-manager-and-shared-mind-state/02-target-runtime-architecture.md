# Target Runtime Architecture

## Core Design

Introduce a single in-process runtime owner:

- `LoopManager`

That manager owns a set of registered loops implementing a shared contract.

Recommended initial runtime shape:

```text
Gateway
  -> LoopManager
       -> conversation_loop
       -> maintenance_loop
       -> heartbeat_loop
       -> continuity_worker (managed job pool, not equal-priority loop)
       -> shared_mind_state
       -> event_bus
```

## Managed Loops In V1

### 1. Conversation Loop

Purpose:

- handle user-facing turns
- own tool-using foreground reasoning
- update attention/focus state

Properties:

- highest priority
- user-visible
- allowed to interrupt or suppress background surfacing
- non-periodic; event-driven on inbound messages

### 2. Maintenance Loop

Purpose:

- read incremental transcripts
- extract durable memory
- synthesize entity summaries
- write graph-lite updates

Properties:

- background only
- never user-visible
- periodic plus event-driven nudges
- preemptible by conversation

### 3. Heartbeat Loop

Purpose:

- review due follow-ups and related recent state
- decide whether to initiate
- snooze, expire, or surface items

Properties:

- background only unless surfacing is approved
- only eligible while idle
- rate-limited and policy-gated

## Continuity Jobs

Continuity is slightly different.

It is not a steady-state runtime loop in the same way as the other three.

It is better modeled as:

- a managed job class owned by the `LoopManager`
- lower-priority work queued on session transitions
- bounded worker pool with its own status and observability

That keeps the architecture honest.

## Runtime Ownership

The gateway should no longer directly own the detailed lifecycle of each background subsystem.

Instead:

- gateway owns `LoopManager`
- loop manager owns loops
- loops own their own internal timers/tasks
- gateway interacts through a narrow control surface

## Loop Interface

Recommended loop contract:

```python
class ManagedLoop(Protocol):
    name: str
    priority: LoopPriority
    visibility: LoopVisibility

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def on_event(self, event: LoopEvent) -> None: ...
    async def tick(self) -> None: ...
    def status(self) -> dict[str, Any]: ...
```

Not every loop must use `tick()` heavily.

The point is a consistent envelope, not artificial uniformity.

## Why This Architecture Is Right

This architecture does three useful things immediately:

1. gives existing loops a common runtime language
2. centralizes policy and scheduling
3. leaves room for later reflection/drive loops without another refactor

That is enough value to justify the work.
