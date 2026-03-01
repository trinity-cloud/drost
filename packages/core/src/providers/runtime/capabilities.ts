import type { ProviderAdapter, ProviderCapabilities, ProviderFamily, ProviderProfile } from "../types.js";

function normalizeFamily(value: string | undefined): ProviderFamily | null {
  if (!value) {
    return null;
  }
  if (value === "openai-responses" || value === "anthropic-messages" || value === "codex" || value === "legacy") {
    return value;
  }
  return null;
}

function familyFromAdapter(adapterId: string): ProviderFamily | null {
  const normalized = adapterId.trim().toLowerCase();
  if (normalized === "openai-responses") {
    return "openai-responses";
  }
  if (normalized === "anthropic-messages") {
    return "anthropic-messages";
  }
  if (normalized === "codex-exec") {
    return "codex";
  }
  return null;
}

function familyFromKind(kind: ProviderProfile["kind"]): ProviderFamily {
  if (kind === "anthropic") {
    return "anthropic-messages";
  }
  if (kind === "openai-codex") {
    return "codex";
  }
  if (kind === "openai" || kind === "openai-compatible") {
    return "openai-responses";
  }
  return "legacy";
}

export function resolveProviderFamily(profile: ProviderProfile, adapter?: ProviderAdapter): ProviderFamily {
  const explicit = normalizeFamily(profile.family);
  if (explicit) {
    return explicit;
  }

  const fromAdapter = adapter ? familyFromAdapter(adapter.id) : familyFromAdapter(profile.adapterId);
  if (fromAdapter) {
    return fromAdapter;
  }

  return familyFromKind(profile.kind);
}

function defaultCapabilitiesForFamily(family: ProviderFamily): ProviderCapabilities {
  if (family === "openai-responses") {
    return {
      nativeToolCalls: true,
      imageInput: true,
      streaming: true,
      toolResultReplay: true,
      strictJsonSchema: true
    };
  }
  if (family === "anthropic-messages") {
    return {
      nativeToolCalls: true,
      imageInput: true,
      streaming: true,
      toolResultReplay: true
    };
  }
  if (family === "codex") {
    return {
      nativeToolCalls: false,
      imageInput: true,
      streaming: true,
      toolResultReplay: true
    };
  }
  return {
    nativeToolCalls: false,
    imageInput: false,
    streaming: true,
    toolResultReplay: false
  };
}

export function resolveProviderCapabilities(profile: ProviderProfile, adapter?: ProviderAdapter): ProviderCapabilities {
  const family = resolveProviderFamily(profile, adapter);
  const defaults = defaultCapabilitiesForFamily(family);
  const hinted = profile.capabilityHints ?? {};
  const merged: ProviderCapabilities = {
    ...defaults,
    ...hinted
  };

  if (typeof adapter?.supportsNativeToolCalls === "boolean") {
    merged.nativeToolCalls = adapter.supportsNativeToolCalls;
  }
  if (profile.wireQuirks?.disableStrictJsonSchema === true) {
    merged.strictJsonSchema = false;
  }
  return merged;
}
