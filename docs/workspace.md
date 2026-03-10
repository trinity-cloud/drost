# Workspace

Drost operates with two filesystem roots: the repo root (code) and the agent workspace (persistent state).

## Repo Root

Where the Drost source code lives:

```
/path/to/drost/
├── drost/              # Python source
├── tests/              # Test suite
├── docs/               # Documentation
├── .env                # Runtime configuration
├── pyproject.toml      # Project definition
└── README.md
```

## Agent Workspace

Where the agent's persistent runtime state lives (default: `~/.drost`):

```
~/.drost/
├── AGENTS.md           # Agent behavior guidelines
├── BOOTSTRAP.md        # Bootstrap procedure (active until complete)
├── SOUL.md             # Agent personality and voice
├── IDENTITY.md         # Concrete agent identity
├── USER.md             # User profile and preferences
├── TOOLS.md            # Tool usage guidelines
├── HEARTBEAT.md        # Heartbeat behavior policy
├── MEMORY.md           # Top-level memory file
├── .bootstrap-complete # Created when bootstrap is done
│
├── memory/
│   ├── daily/
│   │   └── YYYY-MM-DD.md
│   ├── entities/
│   │   └── <type>/<id>/
│   │       ├── items.md
│   │       ├── aliases.md
│   │       ├── relations.md
│   │       └── summary.md
│   └── follow-ups.json
│
├── sessions/
│   ├── <session-key>.jsonl
│   └── <session-key>.full.jsonl
│
├── traces/
│   ├── runs.jsonl
│   └── tools.jsonl
│
├── attachments/
│   └── telegram/
│
├── state/
│   └── shared-mind-state.json
│
├── deployer/
│   ├── status.json
│   ├── events.jsonl
│   ├── requests/
│   └── logs/
│
└── drost.sqlite3       # Derived index database
```

## Workspace Bootstrap

On first boot, Drost seeds missing files from in-repo templates. The seeded files provide default structure for:

- `AGENTS.md` — agent behavior contract
- `BOOTSTRAP.md` — first-run bootstrap procedure
- `SOUL.md` — personality definition
- `IDENTITY.md` — agent identity (filled during bootstrap)
- `USER.md` — user profile (filled during bootstrap)
- `TOOLS.md` — tool usage guidance
- `HEARTBEAT.md` — idle behavior policy
- `MEMORY.md` — initial memory file

**Existing files are never overwritten.** This means you can freely edit any workspace file and it will persist across restarts.

The bootstrap is active until `.bootstrap-complete` is created in the workspace root. During bootstrap, the agent focuses on establishing a concrete identity and user profile.

## System Prompt Assembly

The system prompt is assembled from workspace files + runtime context:

1. Base prompt (agent identity)
2. Tooling section (available tools)
3. Tool style, memory recall, and deployer guidance
4. Workspace runtime info (repo root, workspace root, health URL, timezone)
5. Workspace files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, etc.)
6. Session continuity (if early in a new session)
7. History summary (if compaction was triggered)
8. Memory capsule (ranked memory excerpts)
9. Follow-up block (due follow-ups)
10. Tool execution contract
11. Run hints

Everything is truncated to fit the system prompt token budget (`DROST_CONTEXT_BUDGET_SYSTEM_TOKENS`).

## Prompt Workspace Files

Control which files are injected into the system prompt:

```env
DROST_PROMPT_WORKSPACE_FILES=SOUL.md,IDENTITY.md,USER.md,MEMORY.md
```

You can add custom files to the workspace and include them in the prompt by adding their names to this list.
