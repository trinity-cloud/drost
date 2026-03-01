import type {
  ProviderAdapter,
  ProviderFamily,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnResult
} from "../types.js";
import { resolveProviderFamily } from "./capabilities.js";
import type { ProviderRuntimeDialect, ProviderRuntimeProbeParams, ProviderRuntimeTurnParams } from "./types.js";

function passThroughProbe(params: ProviderRuntimeProbeParams): Promise<ProviderProbeResult> {
  return params.adapter.probe(params.profile, params.context);
}

function passThroughTurn(params: ProviderRuntimeTurnParams): Promise<ProviderTurnResult | void> {
  return params.adapter.runTurn(params.request);
}

function createFamilyDialect(params: { id: string; family: ProviderFamily }): ProviderRuntimeDialect {
  return {
    id: params.id,
    family: params.family,
    supports(profile: ProviderProfile, adapter: ProviderAdapter): boolean {
      return resolveProviderFamily(profile, adapter) === params.family;
    },
    probe: passThroughProbe,
    runTurn: passThroughTurn
  };
}

const OPENAI_RESPONSES_DIALECT = createFamilyDialect({
  id: "openai-responses-dialect",
  family: "openai-responses"
});

const ANTHROPIC_MESSAGES_DIALECT = createFamilyDialect({
  id: "anthropic-messages-dialect",
  family: "anthropic-messages"
});

const CODEX_DIALECT = createFamilyDialect({
  id: "codex-dialect",
  family: "codex"
});

const LEGACY_DIALECT: ProviderRuntimeDialect = {
  id: "legacy-adapter-dialect",
  family: "legacy",
  supports: () => true,
  probe: passThroughProbe,
  runTurn: passThroughTurn
};

export function defaultProviderRuntimeDialects(): ProviderRuntimeDialect[] {
  return [OPENAI_RESPONSES_DIALECT, ANTHROPIC_MESSAGES_DIALECT, CODEX_DIALECT, LEGACY_DIALECT];
}
