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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-control-api-"));
  tempDirs.push(dir);
  return dir;
}

class EchoAdapter implements ProviderAdapter {
  readonly id = "test-echo-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    const input =
      request.messages
        .filter((entry) => entry.role === "user")
        .at(-1)?.content ?? "";
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway control api and observability", () => {
  it("serves control endpoints with auth scopes and mutation rules", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      controlApi: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: "admin-token",
        readToken: "read-token",
        allowLoopbackWithoutAuth: false
      },
      providers: {
        defaultSessionProvider: "echo",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "echo",
            adapterId: "test-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "auth:echo"
          }
        ],
        adapters: [new EchoAdapter()]
      }
    });

    await gateway.start();
    try {
      const controlUrl = gateway.getStatus().controlUrl;
      expect(controlUrl).toBeDefined();

      const unauthorized = await fetch(`${controlUrl}/status`);
      expect(unauthorized.status).toBe(401);

      const read = await fetch(`${controlUrl}/status`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      expect(read.status).toBe(200);
      const readPayload = (await read.json()) as { ok: boolean };
      expect(readPayload.ok).toBe(true);

      const forbidden = await fetch(`${controlUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer read-token"
        },
        body: JSON.stringify({
          channel: "local"
        })
      });
      expect(forbidden.status).toBe(403);

      const created = await fetch(`${controlUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-token"
        },
        body: JSON.stringify({
          channel: "local"
        })
      });
      expect(created.status).toBe(200);
      const createdPayload = (await created.json()) as { ok: boolean; sessionId?: string };
      expect(createdPayload.ok).toBe(true);
      expect(typeof createdPayload.sessionId).toBe("string");

      const turn = await fetch(`${controlUrl}/chat/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-token"
        },
        body: JSON.stringify({
          sessionId: createdPayload.sessionId,
          input: "hello control api"
        })
      });
      expect(turn.status).toBe(200);
      const turnPayload = (await turn.json()) as { ok: boolean; response?: string };
      expect(turnPayload.ok).toBe(true);
      expect(turnPayload.response).toContain("echo:hello control api");

      const retention = await fetch(`${controlUrl}/sessions/retention`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      expect(retention.status).toBe(200);
      const retentionPayload = (await retention.json()) as { ok: boolean; retention?: { totalSessions?: number } };
      expect(retentionPayload.ok).toBe(true);
      expect(retentionPayload.retention?.totalSessions).toBeGreaterThan(0);

      const prune = await fetch(`${controlUrl}/sessions/prune`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-token"
        },
        body: JSON.stringify({
          dryRun: true
        })
      });
      expect(prune.status).toBe(200);
      const prunePayload = (await prune.json()) as {
        ok: boolean;
        prune?: { dryRun?: boolean };
      };
      expect(prunePayload.ok).toBe(true);
      expect(prunePayload.prune?.dryRun).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it("enforces control mutation rate limiting", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      controlApi: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: "admin-token",
        readToken: "read-token",
        allowLoopbackWithoutAuth: false,
        mutationRateLimitPerMinute: 1
      },
      providers: {
        defaultSessionProvider: "echo",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "echo",
            adapterId: "test-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "auth:echo"
          }
        ],
        adapters: [new EchoAdapter()]
      }
    });

    await gateway.start();
    try {
      const controlUrl = gateway.getStatus().controlUrl as string;
      const first = await fetch(`${controlUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-token"
        },
        body: JSON.stringify({
          channel: "local"
        })
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${controlUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-token"
        },
        body: JSON.stringify({
          channel: "local"
        })
      });
      expect(second.status).toBe(429);
    } finally {
      await gateway.stop();
    }
  });

  it("writes runtime, tool, and usage observability streams", async () => {
    const workspaceDir = makeTempDir();
    const observabilityDir = path.join(workspaceDir, ".drost", "observability-test");
    const gateway = createGateway({
      workspaceDir,
      observability: {
        enabled: true,
        directory: observabilityDir
      },
      providers: {
        defaultSessionProvider: "echo",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "echo",
            adapterId: "test-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "auth:echo"
          }
        ],
        adapters: [new EchoAdapter()]
      }
    });

    await gateway.start();
    try {
      gateway.ensureSession("local");
      await gateway.runTool({
        sessionId: "local",
        toolName: "file",
        input: {
          action: "write",
          path: "note.txt",
          content: "hello observability"
        }
      });
      await gateway.runSessionTurn({
        sessionId: "local",
        input: "hi",
        onEvent: () => undefined
      });
    } finally {
      await gateway.stop();
    }

    const runtimeEventsFile = path.join(observabilityDir, "runtime-events.jsonl");
    const toolTracesFile = path.join(observabilityDir, "tool-traces.jsonl");
    const usageEventsFile = path.join(observabilityDir, "usage-events.jsonl");
    expect(fs.existsSync(runtimeEventsFile)).toBe(true);
    expect(fs.existsSync(toolTracesFile)).toBe(true);
    expect(fs.existsSync(usageEventsFile)).toBe(true);

    const runtimeLines = fs
      .readFileSync(runtimeEventsFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const toolLines = fs
      .readFileSync(toolTracesFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const usageLines = fs
      .readFileSync(usageEventsFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(runtimeLines.length).toBeGreaterThan(0);
    expect(toolLines.length).toBeGreaterThan(0);
    expect(usageLines.length).toBeGreaterThan(0);
    expect(() => JSON.parse(runtimeLines[0] as string)).not.toThrow();
    expect(() => JSON.parse(toolLines[0] as string)).not.toThrow();
    expect(() => JSON.parse(usageLines[0] as string)).not.toThrow();
  });
});
