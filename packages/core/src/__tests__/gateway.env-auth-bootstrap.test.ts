import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";

const tempDirs: string[] = [];
const originalSetupToken = process.env.ANTHROPIC_SETUP_TOKEN;
const originalProjectRoot = process.env.DROST_PROJECT_ROOT;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-env-auth-"));
  tempDirs.push(dir);
  return dir;
}

class EnvAuthAdapter implements ProviderAdapter {
  readonly id = "env-auth-adapter";
  lastToken: string | null = null;

  async probe(profile: ProviderProfile, context: ProviderProbeContext): Promise<ProviderProbeResult> {
    this.lastToken = context.resolveBearerToken(profile.authProfileId);
    return {
      providerId: profile.id,
      ok: this.lastToken !== null,
      code: this.lastToken ? "ok" : "missing_auth",
      message: this.lastToken ? "ok" : "missing token"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.lastToken = request.resolveBearerToken(request.profile.authProfileId);
    if (!this.lastToken) {
      throw new Error(`Missing auth profile token: ${request.profile.authProfileId}`);
    }
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "ok"
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "ok"
      }
    });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalSetupToken === undefined) {
    delete process.env.ANTHROPIC_SETUP_TOKEN;
  } else {
    process.env.ANTHROPIC_SETUP_TOKEN = originalSetupToken;
  }
  if (originalProjectRoot === undefined) {
    delete process.env.DROST_PROJECT_ROOT;
  } else {
    process.env.DROST_PROJECT_ROOT = originalProjectRoot;
  }
});

describe("gateway env auth bootstrap", () => {
  it("bootstraps anthropic auth profile from ANTHROPIC_SETUP_TOKEN", async () => {
    const workspaceDir = makeTempDir();
    process.env.ANTHROPIC_SETUP_TOKEN = "sk-ant-oat01-bootstrap-token";
    process.env.DROST_PROJECT_ROOT = workspaceDir;

    const adapter = new EnvAuthAdapter();
    const gateway = createGateway({
      workspaceDir,
      providers: {
        defaultSessionProvider: "anthropic-main",
        startupProbe: {
          enabled: true,
          timeoutMs: 1000
        },
        profiles: [
          {
            id: "anthropic-main",
            adapterId: adapter.id,
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-sonnet-4-5",
            authProfileId: "anthropic:default"
          }
        ],
        adapters: [adapter]
      }
    });

    await gateway.start();
    try {
      gateway.ensureSession("s-1");
      await gateway.runSessionTurn({
        sessionId: "s-1",
        input: "hello",
        onEvent: () => undefined
      });
      expect(adapter.lastToken).toBe("sk-ant-oat01-bootstrap-token");

      const authStorePath = path.join(workspaceDir, ".drost", "auth-profiles.json");
      expect(fs.existsSync(authStorePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(authStorePath, "utf8")) as {
        profiles?: Record<string, { credential?: { value?: string } }>;
      };
      expect(parsed.profiles?.["anthropic:default"]?.credential?.value).toBe(
        "sk-ant-oat01-bootstrap-token"
      );
    } finally {
      await gateway.stop();
    }
  });
});
