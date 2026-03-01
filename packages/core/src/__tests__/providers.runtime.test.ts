import { describe, expect, it } from "vitest";
import { ProviderRuntimeKernel } from "../providers/runtime/kernel.js";
import { resolveProviderCapabilities, resolveProviderFamily } from "../providers/runtime/capabilities.js";
import { resolveProviderAuthMode } from "../providers/runtime/auth.js";
import type { ProviderAdapter, ProviderProbeContext, ProviderProbeResult, ProviderProfile } from "../providers/types.js";

class RuntimeTestAdapter implements ProviderAdapter {
  readonly id: string;
  readonly supportsNativeToolCalls?: boolean;
  constructor(params: { id: string; supportsNativeToolCalls?: boolean }) {
    this.id = params.id;
    this.supportsNativeToolCalls = params.supportsNativeToolCalls;
  }

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(): Promise<void> {
    return;
  }
}

describe("provider runtime capabilities", () => {
  it("resolves provider family by adapter and kind", () => {
    const openaiProfile: ProviderProfile = {
      id: "openai",
      adapterId: "openai-responses",
      kind: "openai",
      model: "gpt",
      authProfileId: "openai:default"
    };
    const anthropicProfile: ProviderProfile = {
      id: "anthropic",
      adapterId: "anthropic-messages",
      kind: "anthropic",
      model: "claude",
      authProfileId: "anthropic:default"
    };
    const codexProfile: ProviderProfile = {
      id: "openai-codex",
      adapterId: "codex-exec",
      kind: "openai-codex",
      model: "gpt-5.3-codex",
      authProfileId: "openai-codex:default"
    };

    expect(resolveProviderFamily(openaiProfile)).toBe("openai-responses");
    expect(resolveProviderFamily(anthropicProfile)).toBe("anthropic-messages");
    expect(resolveProviderFamily(codexProfile)).toBe("codex");
  });

  it("merges capability hints with adapter native tool support", () => {
    const profile: ProviderProfile = {
      id: "local-openai-compatible",
      adapterId: "openai-responses",
      kind: "openai-compatible",
      model: "test",
      authProfileId: "openai-compatible:local",
      capabilityHints: {
        nativeToolCalls: false
      }
    };
    const adapter = new RuntimeTestAdapter({
      id: "openai-responses",
      supportsNativeToolCalls: true
    });

    const capabilities = resolveProviderCapabilities(profile, adapter);
    expect(capabilities.imageInput).toBe(true);
    expect(capabilities.nativeToolCalls).toBe(true);
  });
});

describe("provider runtime auth", () => {
  it("identifies anthropic setup token mode", () => {
    const profile: ProviderProfile = {
      id: "anthropic",
      adapterId: "anthropic-messages",
      kind: "anthropic",
      model: "claude",
      authProfileId: "anthropic:default"
    };
    const adapter = new RuntimeTestAdapter({
      id: "anthropic-messages",
      supportsNativeToolCalls: true
    });
    const mode = resolveProviderAuthMode({
      profile,
      adapter,
      token: "sk-ant-oat01-test"
    });
    expect(mode).toBe("setup_token");
  });
});

describe("provider runtime kernel", () => {
  it("attaches runtime metadata to probe results", async () => {
    const profile: ProviderProfile = {
      id: "xai",
      adapterId: "openai-responses",
      kind: "openai-compatible",
      model: "grok-4",
      authProfileId: "openai-compatible:xai",
      wireQuirks: {
        disableStrictJsonSchema: true
      }
    };
    const adapter = new RuntimeTestAdapter({
      id: "openai-responses",
      supportsNativeToolCalls: true
    });
    const kernel = new ProviderRuntimeKernel();

    const result = await kernel.probe({
      profile,
      adapter,
      context: {
        resolveBearerToken: () => "xai-token",
        timeoutMs: 1000
      }
    });

    expect(result.probeResult.runtime?.dialectId).toBe("openai-responses-dialect");
    expect(result.probeResult.runtime?.family).toBe("openai-responses");
    expect(result.probeResult.runtime?.authMode).toBe("api_key");
    expect(result.probeResult.runtime?.capabilities?.strictJsonSchema).toBe(false);
  });
});
