import type { StreamEventHandler } from "../events.js";
import type { ChatMessage } from "../types.js";
import type { AuthStore } from "../auth/store.js";
import { resolveBearerToken } from "../auth/store.js";
import type { SessionMetadata } from "../sessions.js";
import type {
  ProviderAdapter,
  ProviderProbeResult,
  ProviderProfile,
  ProviderSessionState
} from "./types.js";

export type ProviderFailureClass =
  | "auth"
  | "permission"
  | "rate_limit"
  | "server_error"
  | "network"
  | "timeout"
  | "fatal_request"
  | "unknown";

export interface ProviderFailoverConfig {
  enabled?: boolean;
  chain?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  authCooldownSeconds?: number;
  rateLimitCooldownSeconds?: number;
  serverErrorCooldownSeconds?: number;
}

export interface ProviderFailoverStatus {
  enabled: boolean;
  maxRetries: number;
  chain: string[];
  providers: Array<{
    providerId: string;
    inCooldown: boolean;
    remainingCooldownSeconds: number;
    lastFailureClass?: ProviderFailureClass;
    lastFailureMessage?: string;
    lastFailureAt?: string;
  }>;
}

export interface ProviderRouteSelection {
  routeId?: string;
  primaryProviderId: string;
  fallbackProviderIds?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionMetadata(seed?: Partial<SessionMetadata>): SessionMetadata {
  const now = nowIso();
  const metadata: SessionMetadata = {
    createdAt: seed?.createdAt ?? now,
    lastActivityAt: seed?.lastActivityAt ?? seed?.createdAt ?? now,
    title: seed?.title,
    origin: seed?.origin
  };
  if (typeof seed?.providerRouteId === "string" && seed.providerRouteId.trim().length > 0) {
    metadata.providerRouteId = seed.providerRouteId.trim();
  }
  if (
    seed?.skillInjectionMode === "off" ||
    seed?.skillInjectionMode === "all" ||
    seed?.skillInjectionMode === "relevant"
  ) {
    metadata.skillInjectionMode = seed.skillInjectionMode;
  }
  return metadata;
}

function createUserMessage(content: string): ChatMessage {
  return {
    role: "user",
    content,
    createdAt: nowIso()
  };
}

function createAssistantMessage(content: string): ChatMessage {
  return {
    role: "assistant",
    content,
    createdAt: nowIso()
  };
}

function createToolMessage(content: string): ChatMessage {
  return {
    role: "tool",
    content,
    createdAt: nowIso()
  };
}

function normalizeToolNames(toolNames: string[] | undefined): string[] {
  if (!toolNames) {
    return [];
  }
  return Array.from(
    new Set(
      toolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function createToolInstructionMessage(toolNames: string[]): ChatMessage | null {
  if (toolNames.length === 0) {
    return null;
  }
  return {
    role: "system",
    content: [
      "Tool calling is available for this session.",
      `Available tools: ${toolNames.join(", ")}`,
      "If you need a tool, respond with exactly one line in this format and no additional text:",
      "TOOL_CALL {\"name\":\"<tool_name>\",\"input\":{...}}",
      "After you receive TOOL_RESULT as a tool message, continue with the user response."
    ].join("\n"),
    createdAt: nowIso()
  };
}

function buildTurnMessages(history: ChatMessage[], toolNames: string[]): ChatMessage[] {
  const instruction = createToolInstructionMessage(toolNames);
  if (!instruction) {
    return [...history];
  }
  return [instruction, ...history];
}

function unwrapFencedJson(jsonText: string): string {
  const trimmed = jsonText.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 3) {
    return trimmed;
  }
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!first.startsWith("```") || !last.startsWith("```")) {
    return trimmed;
  }
  return lines.slice(1, -1).join("\n").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function extractToolCallJson(text: string): string | null {
  const markerIndex = text.indexOf("TOOL_CALL");
  if (markerIndex < 0) {
    return null;
  }
  const afterMarker = text.slice(markerIndex + "TOOL_CALL".length).trim();
  if (!afterMarker) {
    return null;
  }

  const unwrapped = unwrapFencedJson(afterMarker);
  return extractFirstJsonObject(unwrapped) ?? extractFirstJsonObject(afterMarker);
}

function parseToolCall(text: string): { toolName: string; input: unknown } | null {
  const trimmed = text.trim();
  if (!trimmed.includes("TOOL_CALL")) {
    return null;
  }
  const jsonPart = extractToolCallJson(trimmed);
  if (!jsonPart) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolName =
    typeof record.name === "string"
      ? record.name.trim()
      : typeof record.tool === "string"
        ? record.tool.trim()
        : "";
  if (!toolName) {
    return null;
  }
  return {
    toolName,
    input: record.input ?? record.arguments ?? {}
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeStreamText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    // Snapshot-style provider chunk with the full text-so-far.
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    // Duplicate or stale chunk.
    return existing;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
    if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}

interface ToolRunResult {
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    issues?: Array<{ path: string; message: string; code?: string }>;
  };
}

function statusFromError(error: unknown): number | null {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };
  const direct = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : null;
  if (direct !== null && Number.isFinite(direct)) {
    return Math.floor(direct);
  }
  const responseStatus =
    typeof value.response?.status === "number"
      ? value.response.status
      : typeof value.response?.statusCode === "number"
        ? value.response.statusCode
        : null;
  if (responseStatus !== null && Number.isFinite(responseStatus)) {
    return Math.floor(responseStatus);
  }
  return null;
}

function classifyProviderFailure(error: unknown): ProviderFailureClass {
  const status = statusFromError(error);
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status !== null && status >= 500) {
    return "server_error";
  }
  if (status !== null && [400, 404, 409, 422].includes(status)) {
    return "fatal_request";
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) {
    return "timeout";
  }
  if (
    message.includes("econn") ||
    message.includes("network") ||
    message.includes("enotfound") ||
    message.includes("ehostunreach")
  ) {
    return "network";
  }
  if (
    message.includes("validation") ||
    message.includes("invalid request") ||
    message.includes("malformed") ||
    message.includes("bad request")
  ) {
    return "fatal_request";
  }
  return "unknown";
}

export class ProviderManager {
  private readonly profileById = new Map<string, ProviderProfile>();
  private readonly adapterById = new Map<string, ProviderAdapter>();
  private readonly sessions = new Map<string, ProviderSessionState>();
  private readonly failover: Required<ProviderFailoverConfig>;
  private readonly providerCooldownUntil = new Map<string, number>();
  private readonly providerFailures = new Map<string, {
    failureClass: ProviderFailureClass;
    message: string;
    timestamp: string;
  }>();

  constructor(params: { profiles: ProviderProfile[]; adapters: ProviderAdapter[]; failover?: ProviderFailoverConfig }) {
    for (const profile of params.profiles) {
      this.profileById.set(profile.id, profile);
    }
    for (const adapter of params.adapters) {
      this.adapterById.set(adapter.id, adapter);
    }
    this.failover = {
      enabled: params.failover?.enabled ?? false,
      chain: [...(params.failover?.chain ?? [])],
      maxRetries: Math.max(1, params.failover?.maxRetries ?? 3),
      retryDelayMs: Math.max(0, params.failover?.retryDelayMs ?? 250),
      backoffMultiplier: Math.max(1, params.failover?.backoffMultiplier ?? 1.5),
      authCooldownSeconds: Math.max(0, params.failover?.authCooldownSeconds ?? 900),
      rateLimitCooldownSeconds: Math.max(0, params.failover?.rateLimitCooldownSeconds ?? 60),
      serverErrorCooldownSeconds: Math.max(0, params.failover?.serverErrorCooldownSeconds ?? 15)
    };
  }

  listProfiles(): ProviderProfile[] {
    return Array.from(this.profileById.values());
  }

  private nowMs(): number {
    return Date.now();
  }

  private remainingCooldownSeconds(providerId: string): number {
    const until = this.providerCooldownUntil.get(providerId);
    if (!until) {
      return 0;
    }
    return Math.max(0, Math.ceil((until - this.nowMs()) / 1000));
  }

  private inCooldown(providerId: string): boolean {
    return this.remainingCooldownSeconds(providerId) > 0;
  }

  private cooldownSecondsForClass(failureClass: ProviderFailureClass): number {
    if (failureClass === "auth" || failureClass === "permission") {
      return this.failover.authCooldownSeconds;
    }
    if (failureClass === "rate_limit") {
      return this.failover.rateLimitCooldownSeconds;
    }
    if (failureClass === "server_error") {
      return this.failover.serverErrorCooldownSeconds;
    }
    return 0;
  }

  private recordProviderFailure(params: {
    providerId: string;
    failureClass: ProviderFailureClass;
    message: string;
  }): void {
    const cooldownSeconds = this.cooldownSecondsForClass(params.failureClass);
    if (cooldownSeconds > 0) {
      this.providerCooldownUntil.set(params.providerId, this.nowMs() + cooldownSeconds * 1000);
    }
    this.providerFailures.set(params.providerId, {
      failureClass: params.failureClass,
      message: params.message,
      timestamp: nowIso()
    });
  }

  private resolveFailoverCandidates(primaryProviderId: string, fallbackProviderIds?: string[]): string[] {
    const chain = [primaryProviderId];
    if (this.failover.enabled) {
      for (const providerId of fallbackProviderIds ?? []) {
        const normalized = providerId.trim();
        if (!normalized || normalized === primaryProviderId) {
          continue;
        }
        chain.push(normalized);
      }
      for (const providerId of this.failover.chain) {
        const normalized = providerId.trim();
        if (!normalized || normalized === primaryProviderId) {
          continue;
        }
        chain.push(normalized);
      }
    }

    const unique = Array.from(new Set(chain));
    const preferred = unique.filter((providerId) => !this.inCooldown(providerId));
    const cooled = unique.filter((providerId) => this.inCooldown(providerId));
    const ordered = [...preferred, ...cooled];
    return ordered.slice(0, Math.max(1, this.failover.maxRetries));
  }

  getFailoverStatus(): ProviderFailoverStatus {
    return {
      enabled: this.failover.enabled,
      maxRetries: this.failover.maxRetries,
      chain: [...this.failover.chain],
      providers: this.listProfiles().map((profile) => {
        const failure = this.providerFailures.get(profile.id);
        return {
          providerId: profile.id,
          inCooldown: this.inCooldown(profile.id),
          remainingCooldownSeconds: this.remainingCooldownSeconds(profile.id),
          lastFailureClass: failure?.failureClass,
          lastFailureMessage: failure?.message,
          lastFailureAt: failure?.timestamp
        };
      })
    };
  }

  listSessions(): ProviderSessionState[] {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      history: [...session.history],
      activeProviderId: session.activeProviderId,
      pendingProviderId: session.pendingProviderId,
      turnInProgress: session.turnInProgress,
      metadata: {
        ...session.metadata
      }
    }));
  }

  hydrateSession(params: {
    sessionId: string;
    history: ChatMessage[];
    activeProviderId?: string;
    pendingProviderId?: string;
    metadata?: Partial<SessionMetadata>;
  }): ProviderSessionState {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    if (params.activeProviderId && !this.profileById.has(params.activeProviderId)) {
      throw new Error(`Unknown provider profile: ${params.activeProviderId}`);
    }
    if (params.pendingProviderId && !this.profileById.has(params.pendingProviderId)) {
      throw new Error(`Unknown provider profile: ${params.pendingProviderId}`);
    }

    session.history = [...params.history];
    if (params.activeProviderId) {
      session.activeProviderId = params.activeProviderId;
    }
    session.pendingProviderId = params.pendingProviderId;
    session.metadata = createSessionMetadata({
      ...session.metadata,
      ...params.metadata
    });
    return session;
  }

  ensureSession(
    sessionId: string,
    initialProviderId: string,
    metadata?: Partial<SessionMetadata>
  ): ProviderSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (metadata) {
        existing.metadata = createSessionMetadata({
          ...existing.metadata,
          ...metadata
        });
      }
      return existing;
    }

    if (!this.profileById.has(initialProviderId)) {
      throw new Error(`Unknown initial provider profile: ${initialProviderId}`);
    }

    const created: ProviderSessionState = {
      sessionId,
      history: [],
      activeProviderId: initialProviderId,
      turnInProgress: false,
      metadata: createSessionMetadata(metadata)
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  getSession(sessionId: string): ProviderSessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (session.turnInProgress) {
      throw new Error(`Cannot delete session in progress: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
    return true;
  }

  renameSession(params: {
    fromSessionId: string;
    toSessionId: string;
  }): ProviderSessionState {
    const from = params.fromSessionId;
    const to = params.toSessionId;
    const source = this.sessions.get(from);
    if (!source) {
      throw new Error(`Unknown session: ${from}`);
    }
    if (source.turnInProgress) {
      throw new Error(`Cannot rename session in progress: ${from}`);
    }
    if (this.sessions.has(to)) {
      throw new Error(`Session already exists: ${to}`);
    }
    this.sessions.delete(from);
    const renamed: ProviderSessionState = {
      ...source,
      sessionId: to,
      metadata: {
        ...source.metadata,
        lastActivityAt: nowIso()
      }
    };
    this.sessions.set(to, renamed);
    return renamed;
  }

  updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): ProviderSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    session.metadata = createSessionMetadata({
      ...session.metadata,
      ...metadata
    });
    return session;
  }

  getSessionHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return [...session.history];
  }

  queueProviderSwitch(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (!this.profileById.has(providerId)) {
      throw new Error(`Unknown provider profile: ${providerId}`);
    }
    session.pendingProviderId = providerId;
  }

  async probeAll(params: {
    authStore: AuthStore;
    timeoutMs: number;
  }): Promise<ProviderProbeResult[]> {
    const probes: ProviderProbeResult[] = [];
    for (const profile of this.profileById.values()) {
      const adapter = this.adapterById.get(profile.adapterId);
      if (!adapter) {
        probes.push({
          providerId: profile.id,
          ok: false,
          code: "provider_error",
          message: `No adapter registered for ${profile.adapterId}`
        });
        continue;
      }

      const result = await adapter.probe(profile, {
        resolveBearerToken: (authProfileId) => resolveBearerToken(params.authStore, authProfileId),
        timeoutMs: params.timeoutMs
      });
      probes.push(result);
    }

    return probes;
  }

  async runTurn(params: {
    sessionId: string;
    input: string;
    authStore: AuthStore;
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
    route?: ProviderRouteSelection;
    availableToolNames?: string[];
    maxToolCalls?: number;
    runTool?: (request: {
      sessionId: string;
      providerId: string;
      toolName: string;
      input: unknown;
      onEvent: StreamEventHandler;
    }) => Promise<ToolRunResult>;
  }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }
    if (session.turnInProgress) {
      throw new Error(`Turn already in progress for session: ${params.sessionId}`);
    }

    // Switches are applied at turn boundaries only.
    if (session.pendingProviderId) {
      session.activeProviderId = session.pendingProviderId;
      session.pendingProviderId = undefined;
    }

    if (!this.profileById.get(session.activeProviderId)) {
      throw new Error(`Unknown active provider profile: ${session.activeProviderId}`);
    }
    let activeProviderId = session.activeProviderId;
    if (params.route?.primaryProviderId) {
      const routeProviderId = params.route.primaryProviderId.trim();
      if (!this.profileById.get(routeProviderId)) {
        throw new Error(`Unknown route primary provider profile: ${routeProviderId}`);
      }
      if (session.activeProviderId !== routeProviderId) {
        session.activeProviderId = routeProviderId;
      }
      activeProviderId = routeProviderId;
    }

    session.history.push(createUserMessage(params.input));
    session.metadata.lastActivityAt = nowIso();
    if (!session.metadata.title && params.input.trim().length > 0) {
      session.metadata.title = params.input.trim().slice(0, 80);
    }
    session.turnInProgress = true;

    const availableToolNames = normalizeToolNames(params.availableToolNames);
    const canRunTools = availableToolNames.length > 0 && typeof params.runTool === "function";
    const maxToolCalls = Math.max(1, params.maxToolCalls ?? 50);
    let remainingToolCalls = maxToolCalls;

    try {
      while (true) {
        const turnResult = await this.runProviderTurnWithFailover({
          sessionId: session.sessionId,
          primaryProviderId: activeProviderId,
          routeId: params.route?.routeId,
          fallbackProviderIds: params.route?.fallbackProviderIds,
          authStore: params.authStore,
          messages: buildTurnMessages(session.history, canRunTools ? availableToolNames : []),
          onEvent: params.onEvent,
          signal: params.signal
        });
        let assistantBuffer = turnResult.assistantBuffer;
        activeProviderId = turnResult.providerId;
        if (session.activeProviderId !== activeProviderId) {
          session.activeProviderId = activeProviderId;
        }

        if (assistantBuffer.trim().length === 0) {
          break;
        }

        const toolCall = canRunTools ? parseToolCall(assistantBuffer) : null;
        if (!toolCall || !params.runTool) {
          session.history.push(createAssistantMessage(assistantBuffer));
          session.metadata.lastActivityAt = nowIso();
          break;
        }

        if (remainingToolCalls <= 0) {
          const message = `Tool call budget exceeded (${maxToolCalls})`;
          params.onEvent({
            type: "provider.error",
            sessionId: session.sessionId,
            providerId: activeProviderId,
            timestamp: nowIso(),
            payload: {
              error: message
            }
          });
          session.history.push(createAssistantMessage(message));
          session.metadata.lastActivityAt = nowIso();
          break;
        }

        remainingToolCalls -= 1;
        const toolResult = await params.runTool({
          sessionId: session.sessionId,
          providerId: activeProviderId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          onEvent: params.onEvent
        });

        session.history.push(
          createToolMessage(
            `TOOL_RESULT ${safeJson({
              name: toolCall.toolName,
              ok: toolResult.ok,
              output: toolResult.output,
              error: toolResult.error
            })}`
          )
        );
        session.metadata.lastActivityAt = nowIso();
      }
    } finally {
      session.turnInProgress = false;
    }
  }

  private async runProviderTurnWithFailover(params: {
    sessionId: string;
    primaryProviderId: string;
    routeId?: string;
    fallbackProviderIds?: string[];
    authStore: AuthStore;
    messages: ChatMessage[];
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }): Promise<{ providerId: string; assistantBuffer: string }> {
    const candidates = this.resolveFailoverCandidates(params.primaryProviderId, params.fallbackProviderIds);
    let lastError: unknown = null;
    let attempt = 0;

    for (const providerId of candidates) {
      attempt += 1;
      const profile = this.profileById.get(providerId);
      if (!profile) {
        continue;
      }
      const adapter = this.adapterById.get(profile.adapterId);
      if (!adapter) {
        continue;
      }

      let assistantBuffer = "";
      const onEvent: StreamEventHandler = (event) => {
        if (event.type === "response.delta" && typeof event.payload.text === "string") {
          assistantBuffer = mergeStreamText(assistantBuffer, event.payload.text);
        }
        params.onEvent(event);
      };

      try {
        await adapter.runTurn({
          sessionId: params.sessionId,
          providerId: profile.id,
          profile,
          messages: params.messages,
          resolveBearerToken: (authProfileId) => resolveBearerToken(params.authStore, authProfileId),
          emit: onEvent,
          signal: params.signal
        });
        return {
          providerId: profile.id,
          assistantBuffer
        };
      } catch (error) {
        lastError = error;
        const failureClass = classifyProviderFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        this.recordProviderFailure({
          providerId: profile.id,
          failureClass,
          message
        });

        params.onEvent({
          type: "provider.error",
          sessionId: params.sessionId,
          providerId: profile.id,
          timestamp: nowIso(),
          payload: {
            error: `Provider ${profile.id} failed (${failureClass}): ${message}`,
            metadata: {
              attempt,
              failureClass,
              failoverEnabled: this.failover.enabled,
              ...(params.routeId ? { routeId: params.routeId } : {}),
              cooldownSeconds: this.remainingCooldownSeconds(profile.id)
            }
          }
        });

        if (!this.failover.enabled || failureClass === "fatal_request") {
          throw error;
        }

        if (attempt < candidates.length && this.failover.retryDelayMs > 0) {
          const delayMs = Math.floor(
            this.failover.retryDelayMs * Math.pow(this.failover.backoffMultiplier, Math.max(0, attempt - 1))
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error(`No provider available for session ${params.sessionId}`);
  }
}
