import type { StreamEventHandler } from "../events.js";
import type { ChatImageRef, ChatInputImage, ChatMessage } from "../types.js";
import type { SessionMetadata } from "../sessions.js";

export type ProviderKind = "openai" | "openai-compatible" | "anthropic" | "openai-codex";
export type ProviderFamily = "openai-responses" | "anthropic-messages" | "codex" | "legacy";

export interface ProviderCapabilities {
  nativeToolCalls: boolean;
  imageInput: boolean;
  streaming: boolean;
  toolResultReplay: boolean;
  strictJsonSchema?: boolean;
  maxImagesPerTurn?: number;
  maxToolsPerTurn?: number;
}

export type ProviderAuthMode = "api_key" | "setup_token" | "oauth" | "cli" | "token" | "unknown";

export interface ProviderProfileWireQuirks {
  xaiXmlToolFallback?: boolean;
  disableStrictJsonSchema?: boolean;
  anthropicSetupTokenMode?: boolean;
}

export interface ProviderProfile {
  id: string;
  adapterId: string;
  kind: ProviderKind;
  family?: ProviderFamily;
  baseUrl?: string;
  model: string;
  authProfileId: string;
  capabilityHints?: Partial<ProviderCapabilities>;
  wireQuirks?: ProviderProfileWireQuirks;
}

export interface ProviderProbeResult {
  providerId: string;
  ok: boolean;
  code:
    | "ok"
    | "missing_profile"
    | "missing_auth"
    | "incompatible_transport"
    | "unreachable"
    | "provider_error";
  message: string;
  runtime?: {
    family?: ProviderFamily;
    dialectId?: string;
    authMode?: ProviderAuthMode;
    capabilities?: ProviderCapabilities;
    warnings?: string[];
  };
}

export interface ProviderProbeContext {
  resolveBearerToken: (authProfileId: string) => string | null;
  timeoutMs: number;
}

export interface ProviderTurnRequest {
  sessionId: string;
  providerId: string;
  profile: ProviderProfile;
  messages: ChatMessage[];
  inputImages?: ChatInputImage[];
  availableTools?: ProviderNativeToolDefinition[];
  resolveInputImageRef?: (ref: ChatImageRef) => ChatInputImage | null;
  resolveBearerToken: (authProfileId: string) => string | null;
  emit: StreamEventHandler;
  signal?: AbortSignal;
}

export interface ProviderNativeToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ProviderNativeToolCall {
  id?: string;
  name: string;
  input: unknown;
}

export interface ProviderTurnResult {
  nativeToolCalls?: ProviderNativeToolCall[];
}

export interface ProviderAdapter {
  id: string;
  supportsNativeToolCalls?: boolean;
  probe(profile: ProviderProfile, context: ProviderProbeContext): Promise<ProviderProbeResult>;
  runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult | void>;
}

export interface ProviderSessionState {
  sessionId: string;
  history: ChatMessage[];
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  metadata: SessionMetadata;
}
