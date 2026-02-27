# Getting Started

## Prerequisites

- Node.js 22+
- pnpm
- Git

## Install From Source

```bash
git clone git@github.com:trinity-cloud/drost.git
cd drost
pnpm install
pnpm build
```

## Enable `drost` Globally (Development)

```bash
pnpm setup
pnpm -C packages/cli link --global
```

You only need to link once per machine/path setup.
After code changes in this repo, run `pnpm build`.

## Repository-As-Agent Workspace

```bash
cd drost
```

Generated structure (high level):

```text
drost/
  drost.config.ts
  packages/
    core/
    cli/
  apps/
  tools/
  memory/
  prompts/
```

Default runtime behavior is permissive: built-in file/code tools are not hard-limited by `mutableRoots`.

## Start the Runtime

```bash
drost start
```

Flags:

```bash
drost start --ui auto
drost start --ui tui
drost start --ui plain
```

## Set Up Credentials

Inside the repo root:

```bash
drost auth doctor
drost auth list
```

Common setup paths:

```bash
# OpenAI Codex OAuth
codex login
drost auth codex-import openai-codex:default

# Anthropic setup-token
# (you can also use set-api-key anthropic ...)
drost auth set-setup-token anthropic:default <token>

# OpenAI API key
drost auth set-api-key openai openai:default <api_key>

# OpenAI-compatible API key (xAI, vLLM, etc.)
drost auth set-api-key openai-compatible openai-compatible:local <api_key>
```

Verify provider reachability:

```bash
drost providers probe 20000
```

## First Runtime Commands

Once started:

- `/providers`
- `/provider <id>`
- `/session <id>`
- `/sessions`
- `/status`
- `/tools`
- `/tool <name> [json]`
- `/restart`
- `/help`

## Next Reads

- [Architecture](architecture.md)
- [Auth & Providers](auth-and-providers.md)
- [Self-Evolution](self-evolution.md)
