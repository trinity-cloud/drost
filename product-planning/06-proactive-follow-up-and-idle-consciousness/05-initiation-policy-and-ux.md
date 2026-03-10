# Initiation Policy And UX

## Core Principle

The hardest part of proactive behavior is not memory. It is restraint.

If Drost follows up too often, too vaguely, or at the wrong time, the magic collapses into annoyance.

So the initiation policy must be explicit.

## What Drost Should Proactively Surface

Good proactive candidates:

- concrete follow-ups tied to a clear prior event
- important health milestones
- explicit commitments the user said mattered
- project-critical unresolved threads
- time-sensitive obligations that are actually due

Examples:

- "You had the CPAP fitting today. How did it go?"
- "You wanted stronger deploy validation. Want me to tackle that now?"
- "You were waiting on approval from Pacific Blue Cross. Any update?"

## What Drost Should Not Surface

Bad proactive candidates:

- generic "just checking in" messages
- weakly inferred emotional outreach
- things already followed up on recently
- low-confidence speculative concerns
- repetitive reminders without new context

Examples to avoid:

- "Hey, how are you feeling today?"
- "Still thinking about your project?"
- "Any updates?" with no concrete referent

## Priority Policy

Recommended default initiation priorities:

- `high`: medical, safety-critical, explicit user priority, time-sensitive obligations
- `medium`: important work threads, promised revisits, active responsibilities
- `low`: soft curiosities or non-urgent check-ins

For v1:

- proactive surfacing should require `high` or strong `medium`
- low-priority items should remain internal unless explicitly requested later

## Cooldown Policy

Drost must not repeatedly surface the same thing.

Recommended defaults:

- per-item cooldown after surfacing: `24` hours
- global proactive cooldown after any proactive message: `6` hours
- hard cap: at most `1` proactive initiation in a rolling `6` hour window

## Message Style

Proactive messages should be:

- short
- concrete
- grounded in prior context
- never overeager

Good pattern:

- direct reference to the remembered item
- one concrete question or offer
- no extra filler

Examples:

- "You had the CPAP fitting today. How did it go?"
- "You wanted stronger deploy validation. I can work on that now if you want."

## Where Proactive Messages Appear

In v1, keep this simple:

- send proactive messages only through the existing Telegram channel

Do not add separate notification channels yet.

## Safety Rule

If the heartbeat decision confidence is weak, do nothing.

This should be the core fail-safe.

The system should bias toward missed opportunities over spam.

## UX Implication

When done correctly, proactive messages should feel like:

- continuity
- attentiveness
- initiative

They should not feel like:

- reminders app spam
- random LLM enthusiasm
- synthetic intimacy
