# Proactive Follow-Up And Idle Consciousness

## Goal

Move Drost from a purely reactive personal agent to a bounded proactive agent that can:

- remember what is worth checking back on
- notice when a follow-up is due
- use idle time to review memory and pending obligations
- decide whether to initiate contact or action

This package is intentionally narrower than a full multi-loop consciousness runtime.

The goal is not to build a sprawling "mind OS" first. The goal is to ship the user-facing magic:

- "you remembered"
- "you followed up"
- "you did not wait to be asked"

## Why This Package Exists

Drost now has:

- persistent sessions
- layered Markdown memory
- graph-lite entity and relationship memory
- continuity across sessions
- graph-aware prompt-time recall
- a supervised long-lived runtime

That means Drost can already remember well.

The next missing capability is behavioral:

- Drost does not yet track due follow-ups as first-class objects
- Drost does not yet switch into a bounded idle cognition mode
- Drost does not yet decide when to proactively surface something
- `HEARTBEAT.md` exists, but there is no software-owned proactive decision system behind it

## Design Thesis

The correct next step is not full parallel consciousness first.

The correct next step is:

1. follow-up extraction
2. due-item storage
3. active vs idle runtime mode
4. bounded heartbeat/drive loop
5. initiation policy and anti-annoyance rules

If those work, the larger loop-manager architecture becomes justified.

If they do not work, a full multi-loop runtime will only magnify noise.

## Documents

- `01-current-state-and-gap.md`: exact gap between current Drost and magical proactive behavior
- `02-follow-up-memory-model.md`: canonical storage model for follow-ups, responsibilities, and due items
- `03-active-vs-idle-runtime.md`: state machine for active mode, idle mode, and transitions
- `04-heartbeat-drive-loop.md`: bounded background cognition design
- `05-initiation-policy-and-ux.md`: when Drost should proactively act, and how
- `06-implementation-workplan.md`: concrete build order, code touchpoints, and acceptance criteria
- `07-test-observability-and-risks.md`: evaluation strategy, metrics, rollout, and failure modes

## Current Code Basis

This package assumes and builds on:

- `/Users/migel/drost/drost/memory_maintenance.py`
- `/Users/migel/drost/drost/memory_capsule.py`
- `/Users/migel/drost/drost/session_continuity.py`
- `/Users/migel/drost/drost/workspace_loader.py`
- `/Users/migel/drost/drost/prompt_assembly.py`
- `/Users/migel/drost/drost/channels/telegram.py`
- `/Users/migel/drost/drost/gateway.py`
- `/Users/migel/drost/drost/deployer/`

## Bottom Line

Drost now needs a small proactive brain before it needs a grand consciousness architecture.

The next serious build should let Drost:

1. detect follow-up-worthy items
2. track when they become due
3. review them while idle
4. decide whether to act
5. surface proactive follow-ups without becoming noisy or annoying
