import fs from "node:fs";
import path from "node:path";
import { resolveBearerToken, type AuthStore } from "../../auth/store.js";
import type { ProviderProfile } from "../types.js";

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function parseDotEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function loadProjectEnvFilesIntoProcess(cwd: string): void {
  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }
      const key = match[1];
      const rawValue = match[2] ?? "";
      if (!key) {
        continue;
      }
      const existing = process.env[key];
      if (typeof existing === "string" && existing.trim().length > 0) {
        continue;
      }
      process.env[key] = parseDotEnvValue(rawValue);
    }
  }
}

function ensureProviderEnvLoaded(): void {
  if (nonEmpty(process.env.ANTHROPIC_SETUP_TOKEN) || nonEmpty(process.env.XAI_API_KEY)) {
    return;
  }
  const candidates = new Set<string>([process.cwd()]);
  const projectRoot = nonEmpty(process.env.DROST_PROJECT_ROOT);
  if (projectRoot) {
    candidates.add(projectRoot);
  }
  for (const candidate of candidates) {
    loadProjectEnvFilesIntoProcess(candidate);
  }
}

function isAnthropicProfile(profile: ProviderProfile, authProfileId: string): boolean {
  if (profile.kind === "anthropic") {
    return true;
  }
  const profileId = profile.id.toLowerCase();
  const authId = authProfileId.toLowerCase();
  const adapterId = profile.adapterId.toLowerCase();
  return (
    profileId.includes("anthropic") ||
    authId.includes("anthropic") ||
    adapterId.includes("anthropic")
  );
}

function isXaiProfile(profile: ProviderProfile, authProfileId: string): boolean {
  const profileId = profile.id.toLowerCase();
  const authId = authProfileId.toLowerCase();
  if (profileId.includes("xai") || authId.includes("xai")) {
    return true;
  }
  const model = profile.model.trim().toLowerCase();
  if (model.includes("grok")) {
    return true;
  }
  const baseUrl = profile.baseUrl?.trim().toLowerCase() ?? "";
  return baseUrl.includes("x.ai");
}

function providerEnvToken(profile: ProviderProfile, authProfileId: string): string | null {
  ensureProviderEnvLoaded();

  if (isAnthropicProfile(profile, authProfileId)) {
    return nonEmpty(process.env.ANTHROPIC_SETUP_TOKEN) ?? nonEmpty(process.env.ANTHROPIC_API_KEY);
  }
  if (isXaiProfile(profile, authProfileId)) {
    return nonEmpty(process.env.XAI_API_KEY);
  }
  return null;
}

export function resolveProviderEnvToken(profile: ProviderProfile, authProfileId: string): string | null {
  return providerEnvToken(profile, authProfileId);
}

export function resolveProviderBearerToken(params: {
  authStore: AuthStore;
  profile: ProviderProfile;
  authProfileId: string;
}): string | null {
  const stored = nonEmpty(resolveBearerToken(params.authStore, params.authProfileId) ?? undefined);
  if (stored) {
    return stored;
  }
  return resolveProviderEnvToken(params.profile, params.authProfileId);
}
