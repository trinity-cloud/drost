import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";
import type { GatewayConfig } from "../config.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-session-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeAdapter implements ProviderAdapter {
  readonly id = "fake-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    const text = `reply:${request.providerId}`;
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text }
    });
  }
}

describe("gateway session store", () => {
  it("persists session history and pending provider state across gateway restarts", async () => {
    const workspaceDir = makeTempDir();
    const adapters = [new FakeAdapter()];

    const baseConfig: GatewayConfig = {
      workspaceDir,
      sessionStore: {
        enabled: true
      },
      providers: {
        defaultSessionProvider: "provider-a",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "provider-a",
            adapterId: "fake-adapter",
            kind: "openai-compatible",
            baseUrl: "https://example.com",
            model: "demo-a",
            authProfileId: "auth:a"
          },
          {
            id: "provider-b",
            adapterId: "fake-adapter",
            kind: "openai-compatible",
            baseUrl: "https://example.com",
            model: "demo-b",
            authProfileId: "auth:b"
          }
        ],
        adapters
      }
    };

    const first = createGateway(baseConfig);
    await first.start();
    first.ensureSession("alpha");
    await first.runSessionTurn({
      sessionId: "alpha",
      input: "hello",
      onEvent: () => {
        // no-op
      }
    });
    first.queueSessionProviderSwitch("alpha", "provider-b");
    await first.stop();

    const second = createGateway(baseConfig);
    await second.start();
    second.ensureSession("alpha");

    const restored = second.getSessionState("alpha");
    expect(restored?.activeProviderId).toBe("provider-a");
    expect(restored?.pendingProviderId).toBe("provider-b");

    const snapshots = second.listSessionSnapshots();
    const alpha = snapshots.find((session) => session.sessionId === "alpha");
    expect(alpha?.historyCount).toBe(2);

    await second.stop();
  });
});
