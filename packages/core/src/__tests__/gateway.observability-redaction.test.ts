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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-observability-redaction-"));
  tempDirs.push(dir);
  return dir;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class EchoAdapter implements ProviderAdapter {
  readonly id = "redaction-echo-adapter";

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

describe("gateway observability redaction", () => {
  it("redacts known sensitive values and clips observability payloads", async () => {
    const workspaceDir = makeTempDir();
    const observabilityDir = path.join(workspaceDir, ".drost", "observability");
    const rawSecret = "sk-test-very-sensitive-1234567890";
    const rawBearer = "Bearer secret-token-value-abcdefghijklmnopqrstuvwxyz";

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
            adapterId: "redaction-echo-adapter",
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
      const toolResult = await gateway.runTool({
        sessionId: "local",
        toolName: "file",
        input: {
          action: "write",
          path: "note.txt",
          content: `token=${rawSecret}`,
          password: "super-secret-password",
          headers: {
            Authorization: rawBearer
          }
        } as unknown
      });
      expect(toolResult.ok).toBe(true);

      await gateway.runSessionTurn({
        sessionId: "local",
        input: `my api_key=${rawSecret} ${rawBearer}`,
        onEvent: () => undefined
      });
    } finally {
      await gateway.stop();
    }

    const toolTracePath = path.join(observabilityDir, "tool-traces.jsonl");
    const usagePath = path.join(observabilityDir, "usage-events.jsonl");
    expect(fs.existsSync(toolTracePath)).toBe(true);
    expect(fs.existsSync(usagePath)).toBe(true);

    const toolTraceText = fs.readFileSync(toolTracePath, "utf8");
    const usageText = fs.readFileSync(usagePath, "utf8");
    expect(toolTraceText).not.toContain(rawSecret);
    expect(toolTraceText).not.toContain(rawBearer);
    expect(usageText).not.toContain(rawSecret);
    expect(usageText).not.toContain(rawBearer);
    expect(toolTraceText).toContain("[REDACTED]");

    const toolEntries = readJsonl(toolTracePath);
    const started = toolEntries.find((entry) => (entry.payload as { phase?: string } | undefined)?.phase === "started");
    const startedPayload = started?.payload as
      | {
          input?: {
            password?: string;
            headers?: Record<string, string>;
          };
        }
      | undefined;
    expect(startedPayload?.input?.password).toBe("[REDACTED]");
    expect(startedPayload?.input?.headers?.Authorization).toBe("[REDACTED]");
  });
});
