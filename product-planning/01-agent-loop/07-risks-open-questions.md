# Risks and Open Questions

## 1. Provider Compatibility Risks

## 1.1 OpenAI-Codex Backend Differences

Risk:

- Codex backend may require streaming behavior and have slight API differences vs platform OpenAI responses.

Mitigation:

- keep fallback to stream-buffered path (already used in Drost),
- add parser tests against representative stream events.

## 1.2 Anthropic Setup-Token Mode

Risk:

- setup-token/oAuth mode has stricter expectations for request headers and tooling semantics.

Mitigation:

- keep existing Claude Code-style headers,
- test tool-calling path specifically with setup-token mode enabled.

## 1.3 xAI OpenAI-Compatible Variance

Risk:

- tool call event shape may differ slightly from OpenAI official stream events.

Mitigation:

- implement resilient parser that tolerates missing/alternate fields,
- add compatibility tests with mocked xAI-like payloads.

## 2. Loop Stability Risks

## 2.1 Infinite/Repetitive Tool Loops

Risk:

- model can repeatedly call same tool with same args.

Mitigation:

- max iteration cap,
- repeated-call fingerprint detector,
- clear user-facing limit-stop messaging.

## 2.2 Tool Error Amplification

Risk:

- model repeatedly retries failing tool after recoverable errors.

Mitigation:

- include concise error text for model reasoning,
- optionally disable specific tool after repeated identical failures in one run.

## 3. Data and Memory Risks

## 3.1 Over-Injection of Memory

Risk:

- large memory retrieval payloads can degrade response quality and increase costs.

Mitigation:

- bounded `top_k`,
- bounded snippet length,
- consistent memory formatting contract.

## 3.2 Sensitive Data in Tool Traces

Risk:

- tool args/results may contain secrets and end up in logs/traces.

Mitigation:

- redact known secret patterns,
- bound payload length in persisted traces,
- allow trace disable config for strict deployments.

## 4. Product Risks

## 4.1 Complexity Drift Toward reference implementation

Risk:

- Drost might inherit too much complexity and lose "stripped-down OSS" identity.

Mitigation:

- enforce strict non-goals for v1,
- keep architecture lean while still shipping practical action tools,
- defer plugins and orchestration modes.

## 4.2 Backward Compatibility

Risk:

- loop integration may change output timing/shape expected by current Telegram users.

Mitigation:

- keep user-facing reply semantics stable,
- use a single editable "working" message for progress updates.

## 5. Locked Decisions

1. v1 tool set includes:
   - `memory_search`
   - `memory_get`
   - `session_status`
   - `file_read`
   - `file_write`
   - `shell_execute`
   - `web_search`
   - `web_fetch`
2. Tool execution is unrestricted in v1 (filesystem read/write and command execution with no confirmation/sandbox layer).
3. Prompt identity source is `SOUL.md` with additional workspace context files.
4. Telegram progress UX edits a single in-flight "working" message.
5. Default context budget target is `96K` total with `24K/24K/24K/24K` split (system/history/memory/reserve), and these are soft defaults rather than hard min/max limits.
6. `web_search` backend is Exa in v1, configured via `EXA_API_KEY` from `.env`/environment.
7. History summarization follows compaction strategy:
   - deterministic truncation by default,
   - threshold-triggered summarization only,
   - fallback to truncation on summary failure.

## 6. Remaining Open Questions

1. Should traces default to enabled or opt-in?
2. Should provider-specific tool support be toggleable per provider at runtime?
3. Should loop metrics be exposed via HTTP endpoint in v1 or logs-only?
4. What should the default `agent_max_iterations` be for first OSS release?

## 7. Recommended Defaults for Remaining Questions

1. Keep traces enabled but minimal and redacted.
2. Keep tool support on for providers that parse correctly; auto-disable with warning when unsupported.
3. Expose minimal `/v1/runs/last` diagnostic endpoint.
4. Default `agent_max_iterations = 10`.
