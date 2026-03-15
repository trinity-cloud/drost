# Target Product And Runtime Shape

## Objective

Give Drost a first-class supervised recursive-improvement operating model.

The target is not unrestricted autonomy.
The target is a runtime that can improve itself under explicit supervision, with reliable reporting and rollback.

## Target Product Behavior

After this package, Drost should be able to say things like:

- "I inspected the current runtime and found a deployer flaw."
- "I delegated a bounded patch to Claude Code."
- "I reviewed the resulting diff and reran the relevant test slice."
- "The patch is committed but not live yet."
- "Deploy request is active and the runtime is still on commit X."
- "Candidate became active and healthy; promotion succeeded."

Those statements should be grounded in real state, not inferred from intent.

## Target Runtime Shape

### 1. Foreground Conversation Layer

The user-facing run should stay short and decisive.

Foreground turns should:

- inspect current verified state
- decide what work must happen now
- launch or continue bounded work
- report exact verified progress
- not babysit a worker indefinitely

### 2. Supervision Layer

Drost should own a real supervision workflow for external workers.

That workflow should include:

- worker launch
- task spec creation
- output/log capture
- diff inspection
- test inspection
- stop/continue decision
- escalation path when the worker is blocked or stale

### 3. Control Plane Layer

Deployer semantics must become unambiguous.

Control plane should distinguish clearly between:

- repo worktree state
- candidate commit
- active runtime commit
- known-good commit
- requested deploy vs active deploy vs completed deploy

### 4. Operational Memory Layer

Drost should retain operational truths the same way it retains user truths.

It needs durable memory for:

- deploy playbooks
- worker constraints
- runtime capabilities
- known failure modes
- safe reporting rules

### 5. Product Surface Layer

The final product surface should support:

- self-inspection
- self-improvement proposals
- supervised execution
- validated rollout
- postmortem learning

## Deliberate Non-Goals

This package should not add:

- unconstrained autonomous self-editing
- arbitrary background code writing loops
- free-form multi-agent swarms
- direct trust in external worker claims without verification

## Success Criteria

Drost should end this package with:

1. operationally bounded supervision
2. correct deploy semantics
3. better self-model freshness
4. stronger reporting discipline
5. a reusable substrate for future recursive-improvement features
