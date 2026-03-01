import type { ProviderAdapter, ProviderAuthMode, ProviderProfile } from "../types.js";
import { resolveProviderFamily } from "./capabilities.js";

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function looksLikeAnthropicSetupToken(token: string): boolean {
  const normalized = token.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("sk-ant-oat")) {
    return true;
  }
  const setupToken = nonEmpty(process.env.ANTHROPIC_SETUP_TOKEN);
  return Boolean(setupToken && setupToken === normalized);
}

export function resolveProviderAuthMode(params: {
  profile: ProviderProfile;
  adapter?: ProviderAdapter;
  token?: string | null;
}): ProviderAuthMode {
  const token = nonEmpty(params.token);
  const family = resolveProviderFamily(params.profile, params.adapter);

  if (family === "codex" || params.adapter?.id === "codex-exec") {
    return "cli";
  }
  if (!token) {
    return "unknown";
  }

  if (family === "anthropic-messages" || params.profile.kind === "anthropic") {
    return looksLikeAnthropicSetupToken(token) ? "setup_token" : "api_key";
  }

  if (params.profile.kind === "openai" || params.profile.kind === "openai-compatible") {
    return "api_key";
  }

  if (token.startsWith("sk-")) {
    return "api_key";
  }
  if (token.startsWith("eyJ")) {
    return "oauth";
  }
  return "token";
}
