import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-orchestration-"));
  tempDirs.push(dir);
  return dir;
}

class BlockingAdapter implements ProviderAdapter {
  readonly id = "blocking-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(new Error("aborted"));
      };
      request.signal?.addEventListener("abort", abort, { once: true });
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "never"
      }
    });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway orchestration persistence", () => {
  it("persists lane snapshot when enabled and restores it on restart", async () => {
    const workspaceDir = makeTempDir();
    const adapter = new BlockingAdapter();
    const config = {
      workspaceDir,
      orchestration: {
        enabled: true,
        defaultMode: "queue" as const,
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
            adapterId: "blocking-adapter",
            kind: "openai-compatible" as const,
            model: "demo",
            authProfileId: "auth:echo"
          }
        ],
        adapters: [adapter]
      }
    };

    const gateway = createGateway(config);
    await gateway.start();
    const turnA = gateway
      .runChannelTurn({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        input: "first"
      })
      .catch(() => undefined);
    const turnB = gateway
      .runChannelTurn({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        input: "second"
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const lanesBeforeStop = gateway.listOrchestrationLaneStatuses();
    expect(lanesBeforeStop.length).toBe(1);
    expect(lanesBeforeStop[0]?.active).toBe(true);
    expect(lanesBeforeStop[0]?.queued).toBeGreaterThanOrEqual(1);

    await gateway.stop();
    await Promise.all([turnA, turnB]);

    const statePath = path.join(workspaceDir, ".drost", "orchestration-lanes.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      version: number;
      lanes: Array<{ sessionId: string; queuedInputs: string[]; activeInput?: string }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.lanes.length).toBe(1);
    expect(
      (persisted.lanes[0]?.queuedInputs.length ?? 0) + (persisted.lanes[0]?.activeInput ? 1 : 0)
    ).toBeGreaterThanOrEqual(2);

    const restarted = createGateway(config);
    await restarted.start();
    try {
      const restoredLanes = restarted.listOrchestrationLaneStatuses();
      expect(restoredLanes.length).toBe(1);
      expect(restoredLanes[0]?.queued).toBeGreaterThanOrEqual(1);
    } finally {
      await restarted.stop();
    }
  });
});
