import type {
  ProviderAdapter,
  ProviderAuthMode,
  ProviderCapabilities,
  ProviderFamily,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest,
  ProviderTurnResult
} from "../types.js";

export interface ProviderRuntimePlan {
  family: ProviderFamily;
  dialectId: string;
  authMode: ProviderAuthMode;
  capabilities: ProviderCapabilities;
  warnings: string[];
}

export interface ProviderRuntimeProbeParams {
  profile: ProviderProfile;
  adapter: ProviderAdapter;
  context: ProviderProbeContext;
}

export interface ProviderRuntimeTurnParams {
  adapter: ProviderAdapter;
  request: ProviderTurnRequest;
}

export interface ProviderRuntimeTurnResult {
  turnResult: ProviderTurnResult | void;
  plan: ProviderRuntimePlan;
}

export interface ProviderRuntimeProbeResult {
  probeResult: ProviderProbeResult;
  plan: ProviderRuntimePlan;
}

export interface ProviderRuntimeDialect {
  id: string;
  family: ProviderFamily;
  supports(profile: ProviderProfile, adapter: ProviderAdapter): boolean;
  probe(params: ProviderRuntimeProbeParams): Promise<ProviderProbeResult>;
  runTurn(params: ProviderRuntimeTurnParams): Promise<ProviderTurnResult | void>;
}
