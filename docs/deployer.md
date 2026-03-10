# Deployer

Drost includes a built-in local deployer control plane that supervises the gateway process. This is the default run mode.

## How It Works

When you run `uv run drost`, the deployer:

1. Spawns `drost-gateway` as a child subprocess.
2. Monitors the child process.
3. Handles restart, deploy, and rollback requests through a file-backed queue.
4. Tracks known-good commits for safe rollback.
5. Captures child stdout/stderr to log files.

The deployer runs in the foreground and forwards signals (SIGINT/SIGTERM) to the child for clean shutdown.

## Run Modes

### Supervised Mode (default)

```bash
uv run drost
```

The deployer supervises the gateway. All lifecycle actions go through the control plane.

### Direct Gateway Mode

```bash
uv run drost-gateway
```

Bypasses the deployer entirely. Use for debugging or development.

### Deployer CLI

```bash
uv run drost-deployer status          # Current deployer state
uv run drost-deployer requests        # Pending request queue
uv run drost-deployer events          # Recent event log
uv run drost-deployer events --limit 20
```

## Agent-Initiated Actions

The agent can manage its own runtime through the `deployer_request` and `deployer_status` tools:

```
# The agent can request a restart
deployer_request(action="restart", reason="reload runtime after config change")

# Or deploy a new commit
deployer_request(action="deploy", commit="HEAD", reason="candidate self-edit")

# Or rollback
deployer_request(action="rollback", reason="regression detected")
```

This enables self-modification workflows where the agent can edit its own code and deploy changes through the supervised control plane.

## Operator Commands

From the CLI:

```bash
uv run drost-deployer request restart --reason "reload runtime"
uv run drost-deployer request deploy HEAD --reason "candidate self-edit"
uv run drost-deployer request rollback --reason "operator rollback"
uv run drost-deployer promote   # Mark current commit as known-good
```

## State & Logs

The deployer stores its state under:

```
~/.drost/deployer/
├── status.json          # Current deployer state
├── events.jsonl         # Event log
├── requests/            # File-backed request queue
├── logs/
│   ├── child.stdout.log # Gateway stdout
│   └── child.stderr.log # Gateway stderr
└── config.toml          # Deployer configuration
```

## Health Checks

The deployer validates the child process is healthy by polling the gateway's `/health` endpoint. The health URL is auto-derived from the gateway host and port configuration.

## Configuration

Deployer-specific settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `DROST_RUNTIME_LAUNCH_MODE` | `deployer-default` | Launch mode identifier |
| `DROST_RUNTIME_START_COMMAND` | `uv run drost` | Command to start the gateway |
| `DROST_GATEWAY_HEALTH_URL` | `http://127.0.0.1:8766/health` | Health check endpoint |

A sample deployer config lives at `examples/deployer.config.toml`.
