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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-provider-router-"));
  tempDirs.push(dir);
  return dir;
}

class RoutingAdapter implements ProviderAdapter {
  readonly id = "routing-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    if (request.providerId === "primary-a") {
      const error = new Error("primary-a unavailable") as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    const text = `from:${request.providerId}`;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway provider router", () => {
  it("routes turns by configured route and supports per-session route override", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      providers: {
        defaultSessionProvider: "primary-a",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "primary-a",
            adapterId: "routing-adapter",
            kind: "openai-compatible",
            model: "demo",
            authProfileId: "auth:a"
          },
          {
            id: "fallback-b",
            adapterId: "routing-adapter",
            kind: "openai-compatible",
            model: "demo",
            authProfileId: "auth:b"
          },
          {
            id: "primary-c",
            adapterId: "routing-adapter",
            kind: "openai-compatible",
            model: "demo",
            authProfileId: "auth:c"
          }
        ],
        adapters: [new RoutingAdapter()]
      },
      providerRouter: {
        enabled: true,
        defaultRoute: "route-a",
        routes: [
          {
            id: "route-a",
            primaryProviderId: "primary-a",
            fallbackProviderIds: ["fallback-b"]
          },
          {
            id: "route-c",
            primaryProviderId: "primary-c"
          }
        ]
      },
      failover: {
        enabled: true,
        maxRetries: 3,
        retryDelayMs: 0
      }
    });

    await gateway.start();
    try {
      gateway.ensureSession("local");

      await gateway.runSessionTurn({
        sessionId: "local",
        input: "hello",
        onEvent: () => undefined
      });
      const firstHistory = gateway.getSessionHistory("local");
      expect(firstHistory.at(-1)?.content).toContain("from:fallback-b");
      expect(gateway.getSessionState("local")?.metadata?.providerRouteId).toBe("route-a");

      const routeResult = gateway.setSessionProviderRoute("local", "route-c");
      expect(routeResult.ok).toBe(true);
      expect(gateway.getSessionProviderRoute("local")).toBe("route-c");

      await gateway.runSessionTurn({
        sessionId: "local",
        input: "hello again",
        onEvent: () => undefined
      });
      const secondHistory = gateway.getSessionHistory("local");
      expect(secondHistory.at(-1)?.content).toContain("from:primary-c");
      expect(gateway.exportSession("local")?.metadata.providerRouteId).toBe("route-c");
    } finally {
      await gateway.stop();
    }
  });
});
