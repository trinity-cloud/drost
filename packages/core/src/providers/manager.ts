import type { StreamEventHandler } from "../events.js";
import type { ChatImageRef, ChatInputImage, ChatMessage } from "../types.js";
import type { AuthStore } from "../auth/store.js";
import type { SessionMetadata } from "../sessions.js";
import type {
  ProviderAdapter,
  ProviderProbeResult,
  ProviderProfile,
  ProviderSessionState
} from "./types.js";
import type { ProviderFailureClass } from "./manager/failure.js";
import { type ProviderFailoverConfig, type ProviderFailoverStatus, ProviderFailoverState } from "./manager/failover.js";
import { resolveProviderBearerToken } from "./manager/auth-resolution.js";
import { createAssistantMessage, createToolMessage, createUserMessage, nowIso } from "./manager/metadata.js";
import { runProviderTurnWithFailover } from "./manager/run-provider-turn.js";
import { ProviderSessionRegistry } from "./manager/session-registry.js";
import { buildTurnMessages, normalizeToolNames, parseToolCall, safeJson } from "./manager/tool-calls.js";

export type { ProviderFailureClass, ProviderFailoverConfig, ProviderFailoverStatus };

export interface ProviderRouteSelection {
  routeId?: string;
  primaryProviderId: string;
  fallbackProviderIds?: string[];
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
  private readonly sessions: ProviderSessionRegistry;
  private readonly failover: ProviderFailoverState;

  constructor(params: { profiles: ProviderProfile[]; adapters: ProviderAdapter[]; failover?: ProviderFailoverConfig }) {
    for (const profile of params.profiles) {
      this.profileById.set(profile.id, profile);
    }
    for (const adapter of params.adapters) {
      this.adapterById.set(adapter.id, adapter);
    }
    this.sessions = new ProviderSessionRegistry((providerId) => this.profileById.has(providerId));
    this.failover = new ProviderFailoverState(params.failover);
  }

  listProfiles(): ProviderProfile[] {
    return Array.from(this.profileById.values());
  }

  getFailoverStatus(): ProviderFailoverStatus {
    return this.failover.getStatus(this.listProfiles());
  }

  listSessions(): ProviderSessionState[] {
    return this.sessions.listSessions();
  }

  hydrateSession(params: {
    sessionId: string;
    history: ChatMessage[];
    activeProviderId?: string;
    pendingProviderId?: string;
    metadata?: Partial<SessionMetadata>;
  }): ProviderSessionState {
    return this.sessions.hydrateSession(params);
  }

  ensureSession(
    sessionId: string,
    initialProviderId: string,
    metadata?: Partial<SessionMetadata>
  ): ProviderSessionState {
    return this.sessions.ensureSession(sessionId, initialProviderId, metadata);
  }

  getSession(sessionId: string): ProviderSessionState | null {
    return this.sessions.getSession(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.deleteSession(sessionId);
  }

  renameSession(params: {
    fromSessionId: string;
    toSessionId: string;
  }): ProviderSessionState {
    return this.sessions.renameSession(params);
  }

  updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): ProviderSessionState {
    return this.sessions.updateSessionMetadata(sessionId, metadata);
  }

  getSessionHistory(sessionId: string): ChatMessage[] {
    return this.sessions.getSessionHistory(sessionId);
  }

  queueProviderSwitch(sessionId: string, providerId: string): void {
    this.sessions.queueProviderSwitch(sessionId, providerId);
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
        resolveBearerToken: (authProfileId) =>
          resolveProviderBearerToken({
            authStore: params.authStore,
            profile,
            authProfileId
          }),
        timeoutMs: params.timeoutMs
      });
      probes.push(result);
    }

    return probes;
  }

  async runTurn(params: {
    sessionId: string;
    input: string;
    inputImages?: ChatInputImage[];
    inputImageRefs?: ChatImageRef[];
    resolveInputImageRef?: (ref: ChatImageRef) => ChatInputImage | null;
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
    const session = this.sessions.getSession(params.sessionId);
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

    session.history.push(createUserMessage(params.input, params.inputImageRefs));
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
        const turnResult = await runProviderTurnWithFailover({
          sessionId: session.sessionId,
          primaryProviderId: activeProviderId,
          routeId: params.route?.routeId,
          fallbackProviderIds: params.route?.fallbackProviderIds,
          authStore: params.authStore,
          messages: buildTurnMessages(session.history, canRunTools ? availableToolNames : []),
          inputImages: params.inputImages,
          resolveInputImageRef: params.resolveInputImageRef,
          onEvent: params.onEvent,
          signal: params.signal,
          profiles: this.profileById,
          adapters: this.adapterById,
          failover: this.failover
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
}
