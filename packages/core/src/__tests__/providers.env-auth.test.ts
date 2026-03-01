import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderManager } from "../providers/manager.js";
import type { AuthStore } from "../auth/store.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";

class CapturingAuthAdapter implements ProviderAdapter {
  readonly id = "capturing-auth";
  probeTokens: Array<{ providerId: string; token: string | null }> = [];
  turnTokens: Array<{ providerId: string; token: string | null }> = [];

  async probe(profile: ProviderProfile, context: ProviderProbeContext): Promise<ProviderProbeResult> {
    const token = context.resolveBearerToken(profile.authProfileId);
    this.probeTokens.push({
      providerId: profile.id,
      token
    });
    return {
      providerId: profile.id,
      ok: token !== null,
      code: token ? "ok" : "missing_auth",
      message: token ? "ok" : "missing token"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    const token = request.resolveBearerToken(request.profile.authProfileId);
    this.turnTokens.push({
      providerId: request.providerId,
      token
    });
    if (!token) {
      throw new Error("missing token");
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

function emptyAuthStore(): AuthStore {
  return {
    version: 1,
    profiles: {}
  };
}

const originalAnthropicSetupToken = process.env.ANTHROPIC_SETUP_TOKEN;
const originalXaiApiKey = process.env.XAI_API_KEY;
const originalCwd = process.cwd();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-env-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalAnthropicSetupToken === undefined) {
    delete process.env.ANTHROPIC_SETUP_TOKEN;
  } else {
    process.env.ANTHROPIC_SETUP_TOKEN = originalAnthropicSetupToken;
  }
  if (originalXaiApiKey === undefined) {
    delete process.env.XAI_API_KEY;
  } else {
    process.env.XAI_API_KEY = originalXaiApiKey;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider env auth fallback", () => {
  it("uses ANTHROPIC_SETUP_TOKEN when auth profile is missing", async () => {
    process.env.ANTHROPIC_SETUP_TOKEN = "sk-ant-oat01-env-token";
    delete process.env.XAI_API_KEY;

    const adapter = new CapturingAuthAdapter();
    const manager = new ProviderManager({
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
    });

    const probes = await manager.probeAll({
      authStore: emptyAuthStore(),
      timeoutMs: 1000
    });
    expect(probes[0]?.ok).toBe(true);
    expect(adapter.probeTokens[0]).toEqual({
      providerId: "anthropic-main",
      token: "sk-ant-oat01-env-token"
    });

    manager.ensureSession("s-1", "anthropic-main");
    await manager.runTurn({
      sessionId: "s-1",
      input: "hello",
      authStore: emptyAuthStore(),
      onEvent: () => undefined
    });
    expect(adapter.turnTokens[0]).toEqual({
      providerId: "anthropic-main",
      token: "sk-ant-oat01-env-token"
    });
  });

  it("uses XAI_API_KEY for xAI-compatible providers when auth profile is missing", async () => {
    process.env.XAI_API_KEY = "xai-env-key";
    delete process.env.ANTHROPIC_SETUP_TOKEN;

    const adapter = new CapturingAuthAdapter();
    const manager = new ProviderManager({
      profiles: [
        {
          id: "xai-main",
          adapterId: adapter.id,
          kind: "openai-compatible",
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4",
          authProfileId: "xai:default"
        }
      ],
      adapters: [adapter]
    });

    const probes = await manager.probeAll({
      authStore: emptyAuthStore(),
      timeoutMs: 1000
    });
    expect(probes[0]?.ok).toBe(true);
    expect(adapter.probeTokens[0]).toEqual({
      providerId: "xai-main",
      token: "xai-env-key"
    });

    manager.ensureSession("s-1", "xai-main");
    await manager.runTurn({
      sessionId: "s-1",
      input: "hello",
      authStore: emptyAuthStore(),
      onEvent: () => undefined
    });
    expect(adapter.turnTokens[0]).toEqual({
      providerId: "xai-main",
      token: "xai-env-key"
    });
  });

  it("loads tokens from .env when process env is not pre-populated", async () => {
    delete process.env.ANTHROPIC_SETUP_TOKEN;
    delete process.env.XAI_API_KEY;

    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_SETUP_TOKEN=sk-ant-oat01-from-dotenv\n", "utf8");
    process.chdir(dir);

    const adapter = new CapturingAuthAdapter();
    const manager = new ProviderManager({
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
    });
    manager.ensureSession("s-1", "anthropic-main");

    await manager.runTurn({
      sessionId: "s-1",
      input: "hello",
      authStore: emptyAuthStore(),
      onEvent: () => undefined
    });

    expect(adapter.turnTokens[0]).toEqual({
      providerId: "anthropic-main",
      token: "sk-ant-oat01-from-dotenv"
    });
  });
});
