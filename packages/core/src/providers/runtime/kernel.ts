import type { ProviderAdapter, ProviderProbeResult, ProviderProfile } from "../types.js";
import { resolveProviderAuthMode } from "./auth.js";
import { resolveProviderCapabilities, resolveProviderFamily } from "./capabilities.js";
import { defaultProviderRuntimeDialects } from "./dialects.js";
import type {
  ProviderRuntimeDialect,
  ProviderRuntimePlan,
  ProviderRuntimeProbeParams,
  ProviderRuntimeProbeResult,
  ProviderRuntimeTurnParams,
  ProviderRuntimeTurnResult
} from "./types.js";

function runtimeWarnings(params: {
  profile: ProviderProfile;
  capabilities: ReturnType<typeof resolveProviderCapabilities>;
}): string[] {
  const warnings: string[] = [];
  const profileId = params.profile.id.toLowerCase();
  const looksVllm =
    params.profile.kind === "openai-compatible" &&
    (profileId.includes("vllm") || params.profile.baseUrl?.toLowerCase().includes("localhost"));
  if (looksVllm && !params.capabilities.nativeToolCalls) {
    warnings.push("Native tool calling disabled for openai-compatible profile");
  }
  return warnings;
}

function withRuntimeMetadata(params: {
  probeResult: ProviderProbeResult;
  plan: ProviderRuntimePlan;
}): ProviderProbeResult {
  return {
    ...params.probeResult,
    runtime: {
      family: params.plan.family,
      dialectId: params.plan.dialectId,
      authMode: params.plan.authMode,
      capabilities: params.plan.capabilities,
      warnings: params.plan.warnings.length > 0 ? params.plan.warnings : undefined
    }
  };
}

export class ProviderRuntimeKernel {
  private readonly dialects: ProviderRuntimeDialect[];

  constructor(params?: { dialects?: ProviderRuntimeDialect[] }) {
    this.dialects = params?.dialects ?? defaultProviderRuntimeDialects();
  }

  private resolveDialect(profile: ProviderProfile, adapter: ProviderAdapter): ProviderRuntimeDialect {
    const resolved = this.dialects.find((dialect) => dialect.supports(profile, adapter));
    if (resolved) {
      return resolved;
    }
    return this.dialects[this.dialects.length - 1]!;
  }

  resolvePlan(params: {
    profile: ProviderProfile;
    adapter: ProviderAdapter;
    token?: string | null;
  }): ProviderRuntimePlan {
    const family = resolveProviderFamily(params.profile, params.adapter);
    const capabilities = resolveProviderCapabilities(params.profile, params.adapter);
    const authMode = resolveProviderAuthMode({
      profile: params.profile,
      adapter: params.adapter,
      token: params.token
    });
    const dialect = this.resolveDialect(params.profile, params.adapter);
    const warnings = runtimeWarnings({
      profile: params.profile,
      capabilities
    });
    return {
      family,
      dialectId: dialect.id,
      authMode,
      capabilities,
      warnings
    };
  }

  async probe(params: ProviderRuntimeProbeParams): Promise<ProviderRuntimeProbeResult> {
    const token = params.context.resolveBearerToken(params.profile.authProfileId);
    const plan = this.resolvePlan({
      profile: params.profile,
      adapter: params.adapter,
      token
    });
    const dialect = this.resolveDialect(params.profile, params.adapter);
    const probeResult = await dialect.probe(params);
    return {
      plan,
      probeResult: withRuntimeMetadata({
        probeResult,
        plan
      })
    };
  }

  async runTurn(params: ProviderRuntimeTurnParams): Promise<ProviderRuntimeTurnResult> {
    const token = params.request.resolveBearerToken(params.request.profile.authProfileId);
    const plan = this.resolvePlan({
      profile: params.request.profile,
      adapter: params.adapter,
      token
    });
    const dialect = this.resolveDialect(params.request.profile, params.adapter);
    const turnResult = await dialect.runTurn(params);
    return {
      turnResult,
      plan
    };
  }
}
