import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";
import { saveSessionRecord } from "../sessions.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-session-ops-"));
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
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text: "ok" }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text: "ok" }
    });
  }
}

function makeConfig(workspaceDir: string, sessionDirectory: string): GatewayConfig {
  return {
    workspaceDir,
    sessionStore: {
      enabled: true,
      directory: sessionDirectory
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
          model: "demo",
          authProfileId: "auth:a"
        }
      ],
      adapters: [new FakeAdapter()]
    }
  };
}

describe("gateway session ops", () => {
  it("lists and manages persisted-only sessions", async () => {
    const workspaceDir = makeTempDir();
    const sessionDirectory = path.join(workspaceDir, ".drost", "sessions");
    saveSessionRecord({
      sessionDirectory,
      sessionId: "persisted",
      activeProviderId: "provider-a",
      history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }],
      metadata: {
        createdAt: "2026-02-26T00:00:00.000Z",
        lastActivityAt: "2026-02-26T00:00:01.000Z",
        title: "Persisted"
      }
    });

    const gateway = createGateway(makeConfig(workspaceDir, sessionDirectory));
    await gateway.start();
    try {
      const snapshots = gateway.listSessionSnapshots();
      const persisted = snapshots.find((session) => session.sessionId === "persisted");
      expect(persisted).toBeDefined();
      expect(persisted?.historyCount).toBe(1);
      expect(persisted?.turnInProgress).toBe(false);
      expect(persisted?.metadata.title).toBe("Persisted");

      const renamed = gateway.renameSession({
        fromSessionId: "persisted",
        toSessionId: "persisted-renamed"
      });
      expect(renamed.ok).toBe(true);
      expect(gateway.listPersistedSessionIds()).toContain("persisted-renamed");

      const deleted = gateway.deleteSession("persisted-renamed");
      expect(deleted.ok).toBe(true);
      expect(gateway.listPersistedSessionIds()).not.toContain("persisted-renamed");
    } finally {
      await gateway.stop();
    }
  });

  it("maps channel identities to deterministic session ids", async () => {
    const workspaceDir = makeTempDir();
    const sessionDirectory = path.join(workspaceDir, ".drost", "sessions");
    const gateway = createGateway(makeConfig(workspaceDir, sessionDirectory));
    await gateway.start();
    try {
      const first = gateway.resolveChannelSession({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        title: "Chat 1"
      });
      const second = gateway.resolveChannelSession({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        }
      });
      expect(first).toBe(second);

      const exported = gateway.exportSession(first);
      expect(exported?.metadata.origin?.channel).toBe("telegram");
      expect(exported?.metadata.origin?.workspaceId).toBe("wk-1");
      expect(exported?.metadata.origin?.chatId).toBe("chat-1");
    } finally {
      await gateway.stop();
    }
  });
});
