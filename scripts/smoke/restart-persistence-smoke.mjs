import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../../packages/core/dist/index.js";

class RestartSmokeAdapter {
  constructor() {
    this.id = "restart-smoke-adapter";
  }

  async probe(profile) {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request) {
    const input =
      request.messages
        .filter((entry) => entry.role === "user")
        .at(-1)?.content ?? "";

    if (input.includes("block")) {
      await new Promise((_, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (request.signal?.aborted) {
          onAbort();
          return;
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return;
    }

    const text = `echo:${input}`;
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[restart-persistence-smoke] ${message}`);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`[restart-persistence-smoke] timeout waiting for ${label}`);
}

function createConfig(workspaceDir) {
  return {
    workspaceDir,
    sessionStore: {
      enabled: true
    },
    orchestration: {
      enabled: true,
      defaultMode: "queue",
      defaultCap: 8,
      persistState: true
    },
    providers: {
      defaultSessionProvider: "echo",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "echo",
          adapterId: "restart-smoke-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:echo"
        }
      ],
      adapters: [new RestartSmokeAdapter()]
    }
  };
}

async function run() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-restart-smoke-"));
  const config = createConfig(workspaceDir);

  const first = createGateway(config);
  await first.start();
  let blockedTurns = [];
  try {
    first.ensureSession("persisted");
    await first.runSessionTurn({
      sessionId: "persisted",
      input: "before-restart",
      onEvent: () => undefined
    });

    blockedTurns = [
      first
        .runChannelTurn({
          identity: {
            channel: "telegram",
            workspaceId: "wk",
            chatId: "chat-1"
          },
          input: "block-1"
        })
        .catch(() => undefined),
      first
        .runChannelTurn({
          identity: {
            channel: "telegram",
            workspaceId: "wk",
            chatId: "chat-1"
          },
          input: "queued-2"
        })
        .catch(() => undefined)
    ];

    await waitFor(() => {
      const lanes = first.listOrchestrationLaneStatuses();
      return lanes.length > 0 && lanes.some((lane) => lane.active && lane.queued >= 1);
    }, 15_000, "active + queued lane state");
  } finally {
    await first.stop();
    await Promise.all(blockedTurns);
  }

  const laneStatePath = path.join(workspaceDir, ".drost", "orchestration-lanes.json");
  assert(fs.existsSync(laneStatePath), "missing persisted orchestration state file");
  const persistedLaneState = JSON.parse(fs.readFileSync(laneStatePath, "utf8"));
  assert(Array.isArray(persistedLaneState?.lanes) && persistedLaneState.lanes.length > 0, "persisted lane state missing lanes");

  const second = createGateway(config);
  await second.start();
  try {
    second.ensureSession("persisted");
    const history = second.getSessionHistory("persisted");
    assert(history.some((entry) => entry.content.includes("before-restart")), "persisted session history missing after restart");

    const restoredLanes = second.listOrchestrationLaneStatuses();
    assert(restoredLanes.length > 0, "restored lane state missing after restart");
    assert(restoredLanes.some((lane) => lane.queued >= 1), "restored lanes did not retain queued work");
  } finally {
    await second.stop();
  }

  process.stdout.write(`[restart-persistence-smoke] ok workspace=${workspaceDir}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
