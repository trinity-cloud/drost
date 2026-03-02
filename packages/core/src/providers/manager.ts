import type { StreamEventHandler } from "../events.js";
import type { ChatImageRef, ChatInputImage, ChatMessage } from "../types.js";
import type { AuthStore } from "../auth/store.js";
import type { SessionMetadata } from "../sessions.js";
import type {
  ProviderAdapter,
  ProviderNativeToolDefinition,
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
import { buildTurnMessages, normalizeToolNames, parseToolCall } from "./manager/tool-calls.js";
import { ProviderRuntimeKernel } from "./runtime/kernel.js";
import { resolveProviderCapabilities } from "./runtime/capabilities.js";
import {
  encodeNativeToolCallsMessage,
  encodeToolResultMessage,
  normalizeNativeToolCalls
} from "./tool-protocol.js";

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

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function lastUserMessageText(history: ChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "user") {
      continue;
    }
    const text = message.content.trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function userMessageWantsWebSearch(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/\b(search|look\s*up|lookup|find|browse|web|internet)\b/.test(normalized)) {
    return true;
  }

  if (/\b(news|headline|headlines|update|updates)\b/.test(normalized)) {
    return true;
  }

  if (/\b(today|latest|current|recent|right now|breaking)\b/.test(normalized)) {
    return true;
  }

  return false;
}

function shouldAutoRunWebTool(
  history: ChatMessage[],
  availableToolNames: string[],
  attempted: boolean
): boolean {
  if (attempted || !availableToolNames.includes("web")) {
    return false;
  }

  const latestUserText = lastUserMessageText(history);
  return userMessageWantsWebSearch(latestUserText);
}

function normalizeWebToolInput(input: unknown, history: ChatMessage[]): unknown {
  const record = toRecord(input);
  if (!record) {
    if (typeof input === "string" && input.trim().length > 0) {
      return {
        action: "search",
        query: input.trim()
      };
    }
    return input;
  }

  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (action.length > 0) {
    return input;
  }

  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (query.length > 0) {
    return {
      ...record,
      action: "search",
      query
    };
  }

  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url.length > 0) {
    return {
      ...record,
      action: "fetch",
      url
    };
  }

  const fallbackQuery = lastUserMessageText(history);
  if (fallbackQuery.length > 0) {
    return {
      ...record,
      action: "search",
      query: fallbackQuery
    };
  }

  return {
    ...record,
    action: "search",
    query: "latest news"
  };
}

function normalizeToolInputForExecution(
  toolName: string,
  input: unknown,
  history: ChatMessage[]
): unknown {
  if (toolName !== "web") {
    return input;
  }
  return normalizeWebToolInput(input, history);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function toolCallSignature(toolName: string, input: unknown): string {
  return `${toolName}:${stableJson(input)}`;
}

function normalizeNativeToolDefinitions(
  availableTools: ProviderNativeToolDefinition[] | undefined,
  availableToolNames: string[]
): ProviderNativeToolDefinition[] {
  if (!availableTools || availableTools.length === 0 || availableToolNames.length === 0) {
    return [];
  }
  const allowNames = new Set(availableToolNames);
  const normalized: ProviderNativeToolDefinition[] = [];
  const seen = new Set<string>();

  for (const tool of availableTools) {
    const name = tool?.name?.trim();
    if (!name || !allowNames.has(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({
      name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
          ? tool.inputSchema
          : undefined
    });
  }
  return normalized;
}

export class ProviderManager {
  private readonly profileById = new Map<string, ProviderProfile>();
  private readonly adapterById = new Map<string, ProviderAdapter>();
  private readonly sessions: ProviderSessionRegistry;
  private readonly failover: ProviderFailoverState;
  private readonly runtimeKernel = new ProviderRuntimeKernel();

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

      const result = await this.runtimeKernel.probe({
        profile,
        adapter,
        context: {
          resolveBearerToken: (authProfileId) =>
            resolveProviderBearerToken({
              authStore: params.authStore,
              profile,
              authProfileId
            }),
          timeoutMs: params.timeoutMs
        }
      });
      probes.push(result.probeResult);
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
    availableTools?: ProviderNativeToolDefinition[];
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
    const nativeToolDefinitions = canRunTools
      ? normalizeNativeToolDefinitions(params.availableTools, availableToolNames)
      : [];
    const maxToolCalls = Math.max(1, params.maxToolCalls ?? 50);
    let remainingToolCalls = maxToolCalls;
    let lastValidationFailureSignature = "";
    let repeatedValidationFailureCount = 0;
    const maxRepeatedValidationFailures = 3;
    let autoWebSearchAttempted = false;
    let toolRunOccurred = false;

    try {
      while (true) {
        const shouldBufferAssistantEvents =
          params.runTool != null &&
          !toolRunOccurred &&
          shouldAutoRunWebTool(session.history, availableToolNames, autoWebSearchAttempted);
        const bufferedResponseEvents: Array<Parameters<StreamEventHandler>[0]> = [];
        const providerEventHandler: StreamEventHandler = shouldBufferAssistantEvents
          ? (event) => {
              if (event.type === "response.delta" || event.type === "response.completed") {
                bufferedResponseEvents.push(event);
                return;
              }
              params.onEvent(event);
            }
          : params.onEvent;
        const flushBufferedResponseEvents = (): void => {
          if (!shouldBufferAssistantEvents || bufferedResponseEvents.length === 0) {
            return;
          }
          for (const event of bufferedResponseEvents) {
            params.onEvent(event);
          }
          bufferedResponseEvents.length = 0;
        };
        const discardBufferedResponseEvents = (): void => {
          if (!shouldBufferAssistantEvents || bufferedResponseEvents.length === 0) {
            return;
          }
          bufferedResponseEvents.length = 0;
        };

        const activeProfile = this.profileById.get(activeProviderId);
        const activeAdapter = activeProfile ? this.adapterById.get(activeProfile.adapterId) : undefined;
        const activeCapabilities =
          activeProfile && activeAdapter
            ? resolveProviderCapabilities(activeProfile, activeAdapter)
            : null;
        const preferNativeToolCalling = Boolean(
          canRunTools && nativeToolDefinitions.length > 0 && activeCapabilities?.nativeToolCalls
        );

        const turnResult = await runProviderTurnWithFailover({
          sessionId: session.sessionId,
          primaryProviderId: activeProviderId,
          routeId: params.route?.routeId,
          fallbackProviderIds: params.route?.fallbackProviderIds,
          authStore: params.authStore,
          messages: preferNativeToolCalling
            ? [...session.history]
            : buildTurnMessages(session.history, canRunTools ? availableToolNames : []),
          inputImages: params.inputImages,
          availableTools: nativeToolDefinitions,
          resolveInputImageRef: params.resolveInputImageRef,
          onEvent: providerEventHandler,
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

        const nativeToolCalls = canRunTools ? normalizeNativeToolCalls(turnResult.nativeToolCalls) : [];
        if (nativeToolCalls.length > 0 && params.runTool) {
          session.history.push(createToolMessage(encodeNativeToolCallsMessage(nativeToolCalls)));
          session.metadata.lastActivityAt = nowIso();

          let budgetExceeded = false;
          let stoppedValidationLoop = false;
          for (const nativeToolCall of nativeToolCalls) {
            if (remainingToolCalls <= 0) {
              budgetExceeded = true;
              break;
            }
            remainingToolCalls -= 1;
            toolRunOccurred = true;
            const normalizedInput = normalizeToolInputForExecution(
              nativeToolCall.name,
              nativeToolCall.input,
              session.history
            );
            const toolResult = await params.runTool({
              sessionId: session.sessionId,
              providerId: activeProviderId,
              toolName: nativeToolCall.name,
              input: normalizedInput,
              onEvent: params.onEvent
            });
            session.history.push(
              createToolMessage(
                encodeToolResultMessage({
                  name: nativeToolCall.name,
                  callId: nativeToolCall.id,
                  ok: toolResult.ok,
                  output: toolResult.output,
                  error: toolResult.error
                })
              )
            );
            session.metadata.lastActivityAt = nowIso();

            const signature = toolCallSignature(nativeToolCall.name, normalizedInput);
            if (!toolResult.ok && toolResult.error?.code === "validation_error") {
              if (signature === lastValidationFailureSignature) {
                repeatedValidationFailureCount += 1;
              } else {
                lastValidationFailureSignature = signature;
                repeatedValidationFailureCount = 1;
              }
              if (repeatedValidationFailureCount >= maxRepeatedValidationFailures) {
                const message = `Stopped repeated validation-error tool loop (${nativeToolCall.name})`;
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
                stoppedValidationLoop = true;
                break;
              }
            } else {
              lastValidationFailureSignature = "";
              repeatedValidationFailureCount = 0;
            }
          }

          if (stoppedValidationLoop) {
            discardBufferedResponseEvents();
            break;
          }

          if (budgetExceeded) {
            discardBufferedResponseEvents();
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
          discardBufferedResponseEvents();
          continue;
        }

        if (assistantBuffer.trim().length === 0) {
          flushBufferedResponseEvents();
          break;
        }

        const toolCall = canRunTools
          ? parseToolCall(assistantBuffer, availableToolNames)
          : null;
        if (!toolCall || !params.runTool) {
          if (
            params.runTool &&
            !toolRunOccurred &&
            shouldAutoRunWebTool(session.history, availableToolNames, autoWebSearchAttempted)
          ) {
            if (remainingToolCalls <= 0) {
              discardBufferedResponseEvents();
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
            autoWebSearchAttempted = true;
            toolRunOccurred = true;
            const latestUserText = lastUserMessageText(session.history);
            const normalizedInput = normalizeToolInputForExecution(
              "web",
              {
                action: "search",
                query: latestUserText
              },
              session.history
            );
            const callId = `call_auto_web_${maxToolCalls - remainingToolCalls}`;
            session.history.push(
              createToolMessage(
                encodeNativeToolCallsMessage([
                  {
                    id: callId,
                    name: "web",
                    input: normalizedInput
                  }
                ])
              )
            );
            session.metadata.lastActivityAt = nowIso();

            const toolResult = await params.runTool({
              sessionId: session.sessionId,
              providerId: activeProviderId,
              toolName: "web",
              input: normalizedInput,
              onEvent: params.onEvent
            });
            session.history.push(
              createToolMessage(
                encodeToolResultMessage({
                  name: "web",
                  callId,
                  ok: toolResult.ok,
                  output: toolResult.output,
                  error: toolResult.error
                })
              )
            );
            session.metadata.lastActivityAt = nowIso();

            const signature = toolCallSignature("web", normalizedInput);
            if (!toolResult.ok && toolResult.error?.code === "validation_error") {
              if (signature === lastValidationFailureSignature) {
                repeatedValidationFailureCount += 1;
              } else {
                lastValidationFailureSignature = signature;
                repeatedValidationFailureCount = 1;
              }
              if (repeatedValidationFailureCount >= maxRepeatedValidationFailures) {
                const message = "Stopped repeated validation-error tool loop (web)";
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
            } else {
              lastValidationFailureSignature = "";
              repeatedValidationFailureCount = 0;
            }

            discardBufferedResponseEvents();
            continue;
          }

          flushBufferedResponseEvents();
          session.history.push(createAssistantMessage(assistantBuffer));
          session.metadata.lastActivityAt = nowIso();
          break;
        }

        if (remainingToolCalls <= 0) {
          discardBufferedResponseEvents();
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
        toolRunOccurred = true;
        discardBufferedResponseEvents();
        const normalizedInput = normalizeToolInputForExecution(toolCall.toolName, toolCall.input, session.history);
        const toolResult = await params.runTool({
          sessionId: session.sessionId,
          providerId: activeProviderId,
          toolName: toolCall.toolName,
          input: normalizedInput,
          onEvent: params.onEvent
        });

        session.history.push(
          createToolMessage(
            encodeToolResultMessage({
              name: toolCall.toolName,
              ok: toolResult.ok,
              output: toolResult.output,
              error: toolResult.error
            })
          )
        );
        session.metadata.lastActivityAt = nowIso();

        const signature = toolCallSignature(toolCall.toolName, normalizedInput);
        if (!toolResult.ok && toolResult.error?.code === "validation_error") {
          if (signature === lastValidationFailureSignature) {
            repeatedValidationFailureCount += 1;
          } else {
            lastValidationFailureSignature = signature;
            repeatedValidationFailureCount = 1;
          }
          if (repeatedValidationFailureCount >= maxRepeatedValidationFailures) {
            const message = `Stopped repeated validation-error tool loop (${toolCall.toolName})`;
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
        } else {
          lastValidationFailureSignature = "";
          repeatedValidationFailureCount = 0;
        }
      }
    } finally {
      session.turnInProgress = false;
    }
  }
}
