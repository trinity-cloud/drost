# Current State and Product Signal

## What Happened in the Latest Conversation

The latest live session exposed an important shift in Drost's product shape.

The sequence was:

1. Drost recognized that its cwd is the Drost repo and that it can edit its own source.
2. The user pointed out the hard constraint: if Drost bricks itself and restarts into a broken state, it may not recover.
3. Drost correctly reasoned that rollback requires something outside itself.
4. Drost proposed a deployer/watchdog model.
5. Drost used tools to inspect its own environment and confirmed that the machine already has almost everything needed.
6. Drost then blocked on a packaging preference that should not have blocked forward progress.

This is not just a conversation about tooling. It is a conversation about safe recursive improvement.

## What Drost Already Has

Drost already has most of the substrate needed for self-modification:

- full repo read/write access
- shell command execution
- git repo with commit history
- FastAPI gateway with `/health`
- uv-based launch surface
- tmux-based runtime on the current machine
- persistent memory and transcripts
- enough reasoning quality to identify the rollback problem by itself

In practical terms, Drost can already:

- inspect current code
- patch code
- run tests
- commit changes
- reason about deployment and restart mechanisms

## What Drost Does Not Have Yet

The missing pieces are structural, not cognitive:

- no external supervisor process
- no known-good tracking outside the repo runtime
- no health-gated promotion path
- no automatic rollback path
- no narrow deployer request interface
- no explicit runtime context for repo root and deploy topology

Without those pieces, Drost can edit itself, but it cannot safely promote those edits into a running version.

## Why This Is a Product Feature

The feature is not merely "restart me if I crash."

The actual feature is:

- Drost can improve itself
- Drost can ask for those improvements to be deployed
- the machine decides whether the candidate is healthy
- unhealthy candidates are reverted automatically
- Drost survives bad self-edits

That changes the product category.

Without this feature, self-modification is a high-risk demo behavior.
With this feature, self-modification becomes an operational capability.

## Product Insight From the Transcript

The strongest signal from the transcript is that Drost already understands the right abstraction.

It reasoned toward:

- an external process
- git-based safety points
- health checks
- known-good state
- rollback on failure

That means the conceptual model is already validated by live usage.

## Current Frictions Exposed by the Session

### 1. Repo-root ambiguity

Drost first guessed the repo path incorrectly and had to discover it with tools.

That is avoidable. The runtime should inject explicit context such as:

- repo root
- workspace root
- start command
- health URL
- current process model

Drost should not need to rediscover where it lives during a deploy conversation.

### 2. Packaging choice became a fake blocker

Drost blocked waiting for the user to choose between:

- standalone script
- separate package
- entry point

That should not have happened.

The deployer design is not blocked by that choice. There is a sane default. The agent should have picked it and continued.

### 3. No explicit self-mod protocol

Today Drost would have to improvise its own procedure with ad hoc shell commands.

That is exactly the wrong place to leave a safety-critical feature.

## Requirements Extracted From the Conversation

The live conversation implies these hard requirements for v1:

- Drost must be able to request a supervised restart after self-edits.
- The deployer must run outside the Drost process.
- Health failure must trigger rollback automatically.
- The deployer must track known-good state independently of Drost memory.
- The system must work with the current launch model on the user's machine.
- Drost should not block on arbitrary packaging questions when a sensible default exists.

## Non-Goals for V1

The first version does not need to solve every deployment problem.

It does not need:

- multi-host orchestration
- Kubernetes support
- distributed deployment
- blue/green infra across machines
- container-first operation
- general-purpose CI/CD

V1 only needs to make one local Drost runtime safely self-updatable.

## Recommended Product Framing

The feature should be framed internally as:

- safe self-modification
- supervised self-restart
- candidate promotion and rollback
- external control plane for agent evolution

It should not be framed narrowly as a throwaway helper script.

## Decision

The next build should be a dedicated `drost-deployer` subsystem.

That subsystem should be designed as part of the Drost product, not as a temporary shell wrapper.
