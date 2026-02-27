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

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionMetadata(seed?: Partial<SessionMetadata>): SessionMetadata {
  const now = nowIso();
  return {
    createdAt: seed?.createdAt ?? now,
    lastActivityAt: seed?.lastActivityAt ?? seed?.createdAt ?? now,
    title: seed?.title,
    origin: seed?.origin
  };
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

interface ToolRunResult {
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    issues?: Array<{ path: string; message: string; code?: string }>;
  };
}

export class ProviderManager {
  private readonly profileById = new Map<string, ProviderProfile>();
  private readonly adapterById = new Map<string, ProviderAdapter>();
  private readonly sessions = new Map<string, ProviderSessionState>();

  constructor(params: { profiles: ProviderProfile[]; adapters: ProviderAdapter[] }) {
    for (const profile of params.profiles) {
      this.profileById.set(profile.id, profile);
    }
    for (const adapter of params.adapters) {
      this.adapterById.set(adapter.id, adapter);
    }
  }

  listProfiles(): ProviderProfile[] {
    return Array.from(this.profileById.values());
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

    const profile = this.profileById.get(session.activeProviderId);
    if (!profile) {
      throw new Error(`Unknown active provider profile: ${session.activeProviderId}`);
    }

    const adapter = this.adapterById.get(profile.adapterId);
    if (!adapter) {
      throw new Error(`No adapter registered for ${profile.adapterId}`);
    }

    session.history.push(createUserMessage(params.input));
    session.metadata.lastActivityAt = nowIso();
    if (!session.metadata.title && params.input.trim().length > 0) {
      session.metadata.title = params.input.trim().slice(0, 80);
    }
    session.turnInProgress = true;

    const availableToolNames = normalizeToolNames(params.availableToolNames);
    const canRunTools = availableToolNames.length > 0 && typeof params.runTool === "function";
    const maxToolCalls = Math.max(1, params.maxToolCalls ?? 4);
    let remainingToolCalls = maxToolCalls;

    try {
      while (true) {
        let assistantBuffer = "";
        const onEvent: StreamEventHandler = (event) => {
          if (event.type === "response.delta" && typeof event.payload.text === "string") {
            assistantBuffer += event.payload.text;
          }
          params.onEvent(event);
        };

        await adapter.runTurn({
          sessionId: session.sessionId,
          providerId: profile.id,
          profile,
          messages: buildTurnMessages(session.history, canRunTools ? availableToolNames : []),
          resolveBearerToken: (authProfileId) => resolveBearerToken(params.authStore, authProfileId),
          emit: onEvent,
          signal: params.signal
        });

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
            providerId: profile.id,
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
          providerId: profile.id,
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
}
