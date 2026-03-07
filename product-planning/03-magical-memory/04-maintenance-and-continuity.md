# Maintenance And Continuity

## Goal

Build the software-owned memory processes that turn conversation into durable memory and carry context across session boundaries.

This should follow the Morpheus pattern:

- extraction is not a vague instruction in `HEARTBEAT.md`
- maintenance is a real runtime subsystem
- continuity is a background session handoff job

## Memory Maintenance Runner

## Responsibilities

A Drost memory runner should:

- scan only new transcript lines since the last cursor
- extract daily notes
- extract durable atomic facts into entity folders
- update synthesized summaries on a slower cadence
- trigger reindex of touched files

## Input Sources

Use both transcript files with different purposes.

### User/Assistant JSONL

Best for:

- conversational carryover
- user preferences and decisions
- broad summarization

### Full JSONL

Best for:

- tool artifacts
- file paths
- commands
- fetched evidence
- execution details that matter to future work

A lean first pass can read the full transcript only when available and fall back to the simple transcript otherwise.

## Cursor State

Store maintenance state under:

- `~/.drost/state/memory-maintenance.json`

Minimum fields:

```json
{
  "version": 1,
  "extraction": {
    "files": {
      "main_telegram_...jsonl": {"last_line": 182}
    },
    "last_run_at": "2026-03-06T21:44:00Z"
  },
  "synthesis": {
    "last_week": "2026-W10",
    "last_run_at": "2026-03-06T21:44:00Z"
  }
}
```

This must be incremental. Never rescan the entire history on every run.

## Extraction Output Contract

The model performing extraction should return structured data with two outputs.

### 1. Daily Notes

Example:

```json
[
  {
    "date": "2026-03-06",
    "bullets": [
      "Confirmed that workspace files are injected every LLM turn.",
      "Added media-group Telegram album bundling."
    ]
  }
]
```

### 2. Durable Facts

Example:

```json
[
  {
    "entity_type": "projects",
    "entity_id": "drost",
    "kind": "decision",
    "fact": "Drost memory should use Markdown files as the canonical memory substrate and SQLite as the index.",
    "date": "2026-03-06",
    "confidence": 0.95,
    "source": "sessions/main_telegram_...full.jsonl:144"
  }
]
```

## Write Rules

### Daily Notes

- append bullets to `memory/daily/YYYY-MM-DD.md`
- keep order chronological
- do not aggressively dedupe unless exact duplicate text is present

### Entity Facts

- append to `items.md`
- stable monotonic fact IDs per entity
- skip exact duplicate fact text
- keep facts atomic and plain-language

## Weekly Synthesis

On a slower cadence, rewrite each entity `summary.md` from:

- prior `summary.md`
- tail of `items.md`

The summary should be:

- current
- concise
- useful for prompt-time preload
- not a raw dump of fact bullets

## Triggering Strategy

Recommended schedule:

- once shortly after boot
- every 30 minutes while runtime is alive
- optional opportunistic run after long or very high-signal conversations

Do not trigger a full extraction after every short turn. That creates noise and cost.

## Session Continuity

## Product Goal

When the user starts a new session, Drost should inherit enough carryover that the new thread still feels continuous.

## Design

Use a background continuity manager modeled after Morpheus.

Inputs:

- prior session key
- new session key
- transcript slice from prior session

Output:

- a bounded continuity summary injected into the new session as a synthetic message or equivalent session artifact

## Continuity Summary Shape

Recommended format:

```md
## Session Continuity
### Core Objective
...
### Decisions And Constraints
...
### Work Completed
...
### Open Threads
...
### Suggested Next Actions
...
```

## Continuity Source Selection

Prefer:

- user/assistant transcript for narrative coherence
- selected tool artifacts when they materially affect next steps

Examples of tool artifacts that should survive:

- file paths created or modified
- important commands run
- URLs fetched as evidence
- concrete errors or blockers

## Where Continuity Lives

The continuity summary does not need to become a durable workspace memory file automatically.

Recommended behavior:

- inject into the new session context
- optionally index it as a `transcript_message` or `continuity` source for later recall
- let normal maintenance decide what deserves promotion into daily or entity memory

That keeps continuity useful without polluting canonical memory with every session handoff.

## Separation Of Concerns

Keep these roles distinct:

- transcript JSONL: raw event log
- continuity summary: session-to-session carryover
- daily memory: recent durable notes
- entity memory: structured enduring facts

If those layers blur together, the memory model becomes noisy fast.
