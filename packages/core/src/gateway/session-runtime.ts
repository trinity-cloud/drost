import {
  appendSessionEventRecord,
  applySessionHistoryBudget as applySessionHistoryBudgetPolicy,
  listSessionIds,
  listSessionIndex,
  loadSessionRecordWithDiagnostics,
  saveSessionRecord,
  type SessionMetadata,
  type SessionOriginIdentity
} from "../sessions.js";
import {
  buildChannelSessionId,
  createChannelSessionOrigin,
  type ChannelSessionIdentity,
  type ChannelSessionMappingOptions
} from "../session-mapping.js";
import type { ChatMessage } from "../types.js";
import { normalizeSessionChannelPart, nowIso, sessionTimestampToken } from "./helpers.js";
import type { SessionSnapshot, SessionMutationResult } from "../gateway.js";

export function applySessionHistoryBudget(runtime: any, sessionId: string, history: ChatMessage[]): ChatMessage[] {
  const policy = runtime.config.sessionStore?.history;
  const trimmed = applySessionHistoryBudgetPolicy({
    sessionId,
    history,
    policy
  });
  if (trimmed.trimmed) {
    runtime.emitRuntimeEvent("gateway.degraded", {
      reason: "session_history_trimmed",
      sessionId,
      droppedMessages: trimmed.droppedMessages,
      droppedCharacters: trimmed.droppedCharacters
    });
  }
  return trimmed.history;
}

export function restoreSessionState(runtime: any, sessionId: string): void {
  if (!runtime.sessionStoreEnabled) {
    return;
  }
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return;
  }
  const loaded = loadSessionRecordWithDiagnostics(runtime.sessionDirectory, sessionId);
  if (loaded.diagnostics && loaded.diagnostics.length > 0) {
    for (const diagnostic of loaded.diagnostics) {
      runtime.degradedReasons.push(
        `Session ${sessionId} ${diagnostic.code}: ${diagnostic.message}${diagnostic.quarantinedPath ? ` (${diagnostic.quarantinedPath})` : ""}`
      );
    }
    runtime.state = "degraded";
  }
  if (!loaded.record) {
    return;
  }

  manager.hydrateSession({
    sessionId,
    history: loaded.record.history,
    activeProviderId: loaded.record.activeProviderId,
    pendingProviderId: loaded.record.pendingProviderId,
    metadata: loaded.record.metadata
  });
  if (loaded.record.metadata.providerRouteId) {
    runtime.sessionProviderRouteOverrides.set(sessionId, loaded.record.metadata.providerRouteId);
  }
  if (
    loaded.record.metadata.skillInjectionMode === "off" ||
    loaded.record.metadata.skillInjectionMode === "all" ||
    loaded.record.metadata.skillInjectionMode === "relevant"
  ) {
    runtime.sessionSkillInjectionOverrides.set(sessionId, loaded.record.metadata.skillInjectionMode);
  }
}

export function persistSessionState(runtime: any, sessionId: string): void {
  if (!runtime.sessionStoreEnabled) {
    return;
  }
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return;
  }
  const session = manager.getSession(sessionId);
  if (!session) {
    return;
  }

  session.history = applySessionHistoryBudget(runtime, sessionId, session.history);
  session.metadata.lastActivityAt = nowIso();

  saveSessionRecord({
    sessionDirectory: runtime.sessionDirectory,
    sessionId,
    activeProviderId: session.activeProviderId,
    pendingProviderId: session.pendingProviderId,
    history: session.history,
    metadata: session.metadata,
    lock: runtime.sessionLockOptions()
  });
  try {
    runtime.enforceSessionRetention();
  } catch (error) {
    runtime.degradedReasons.push(
      `Session retention enforcement failed: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export function appendSessionEvent(runtime: any, sessionId: string, eventType: string, payload: unknown): void {
  if (!runtime.sessionStoreEnabled) {
    return;
  }
  try {
    appendSessionEventRecord({
      sessionDirectory: runtime.sessionDirectory,
      sessionId,
      eventType,
      payload,
      timestamp: nowIso(),
      lock: runtime.sessionLockOptions()
    });
  } catch (error) {
    runtime.degradedReasons.push(
      `Failed to append session event for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export function ensureSession(
  runtime: any,
  sessionId: string,
  options?: {
    title?: string;
    origin?: SessionOriginIdentity;
  }
): void {
  if (!runtime.config.providers) {
    throw new Error("No provider manager configured");
  }
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    throw new Error("No provider manager configured");
  }
  manager.ensureSession(sessionId, runtime.config.providers.defaultSessionProvider, {
    title: options?.title,
    origin: options?.origin,
    lastActivityAt: nowIso()
  });
  try {
    restoreSessionState(runtime, sessionId);
  } catch (error) {
    runtime.degradedReasons.push(
      `Failed to restore session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
  persistSessionState(runtime, sessionId);
}

export function sessionExists(runtime: any, sessionId: string): boolean {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return false;
  }
  const manager = runtime.ensureProviderManager();
  if (manager?.getSession(normalizedSessionId)) {
    return true;
  }
  if (!runtime.sessionStoreEnabled) {
    return false;
  }
  return listSessionIds(runtime.sessionDirectory).includes(normalizedSessionId);
}

export function createSession(
  runtime: any,
  options?: {
    channel?: string;
    title?: string;
    origin?: SessionOriginIdentity;
    fromSessionId?: string;
  }
): string {
  const channelPart = normalizeSessionChannelPart(options?.origin?.channel ?? options?.channel);
  const timestamp = sessionTimestampToken();

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const sessionId = attempt === 0 ? `${channelPart}-${timestamp}` : `${channelPart}-${timestamp}-${attempt + 1}`;
    if (sessionExists(runtime, sessionId)) {
      continue;
    }
    ensureSession(runtime, sessionId, {
      title: options?.title,
      origin: options?.origin
    });
    const fromSessionId = options?.fromSessionId?.trim();
    if (fromSessionId && fromSessionId !== sessionId && sessionExists(runtime, fromSessionId)) {
      runtime.scheduleSessionContinuity(fromSessionId, sessionId);
    }
    return sessionId;
  }

  throw new Error("Failed to allocate a unique session id");
}

export function channelSessionKey(
  _runtime: any,
  identity: ChannelSessionIdentity,
  mapping?: ChannelSessionMappingOptions
): string {
  return buildChannelSessionId(identity, mapping);
}

export function createChannelSession(
  runtime: any,
  params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }
): string {
  const channelKey = channelSessionKey(runtime, params.identity, params.mapping);
  const previousSessionId = runtime.channelSessionAssignments.get(channelKey) ?? channelKey;
  const sessionId = createSession(runtime, {
    channel: params.identity.channel,
    title: params.title,
    origin: createChannelSessionOrigin(params.identity),
    fromSessionId: sessionExists(runtime, previousSessionId) ? previousSessionId : undefined
  });
  runtime.channelSessionAssignments.set(channelKey, sessionId);
  return sessionId;
}

export function switchChannelSession(
  runtime: any,
  params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    sessionId: string;
    title?: string;
  }
): SessionMutationResult {
  const targetSessionId = params.sessionId.trim();
  if (!targetSessionId) {
    return {
      ok: false,
      message: "Session id is required"
    };
  }
  if (!sessionExists(runtime, targetSessionId)) {
    return {
      ok: false,
      message: `Unknown session: ${targetSessionId}`
    };
  }

  ensureSession(runtime, targetSessionId, {
    title: params.title,
    origin: createChannelSessionOrigin(params.identity)
  });
  runtime.channelSessionAssignments.set(channelSessionKey(runtime, params.identity, params.mapping), targetSessionId);
  return {
    ok: true,
    message: `Active session switched to ${targetSessionId}`,
    sessionId: targetSessionId
  };
}

export function queueSessionProviderSwitch(runtime: any, sessionId: string, providerId: string): void {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    throw new Error("No provider manager configured");
  }
  manager.queueProviderSwitch(sessionId, providerId);
  persistSessionState(runtime, sessionId);
}

export function getSessionState(
  runtime: any,
  sessionId: string
): { activeProviderId: string; pendingProviderId?: string; metadata?: SessionMetadata } | null {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return null;
  }
  const session = manager.getSession(sessionId);
  if (!session) {
    return null;
  }
  return {
    activeProviderId: session.activeProviderId,
    pendingProviderId: session.pendingProviderId,
    metadata: {
      ...session.metadata
    }
  };
}

export function listSessionSnapshots(runtime: any): SessionSnapshot[] {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return [];
  }
  const snapshots = new Map<string, SessionSnapshot>();
  for (const session of manager.listSessions()) {
    snapshots.set(session.sessionId, {
      sessionId: session.sessionId,
      activeProviderId: session.activeProviderId,
      pendingProviderId: session.pendingProviderId,
      turnInProgress: session.turnInProgress,
      historyCount: session.history.length,
      metadata: {
        ...session.metadata
      }
    });
  }

  if (runtime.sessionStoreEnabled) {
    for (const entry of listSessionIndex(runtime.sessionDirectory)) {
      if (snapshots.has(entry.sessionId)) {
        continue;
      }
      snapshots.set(entry.sessionId, {
        sessionId: entry.sessionId,
        activeProviderId: entry.activeProviderId ?? runtime.config.providers?.defaultSessionProvider ?? "local",
        pendingProviderId: entry.pendingProviderId,
        turnInProgress: false,
        historyCount: entry.historyCount,
        metadata: {
          createdAt: entry.createdAt,
          lastActivityAt: entry.lastActivityAt,
          title: entry.title,
          origin: entry.origin
        }
      });
    }
  }

  return Array.from(snapshots.values()).sort((left, right) => {
    const leftTs = Date.parse(left.metadata.lastActivityAt);
    const rightTs = Date.parse(right.metadata.lastActivityAt);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });
}

export function getSessionHistory(runtime: any, sessionId: string): ChatMessage[] {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return [];
  }
  const liveHistory = manager.getSessionHistory(sessionId);
  if (liveHistory.length > 0) {
    return liveHistory;
  }
  if (!runtime.sessionStoreEnabled) {
    return [];
  }
  return loadSessionRecordWithDiagnostics(runtime.sessionDirectory, sessionId).record?.history ?? [];
}

export function resolveChannelSession(
  runtime: any,
  params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }
): string {
  const channelKey = channelSessionKey(runtime, params.identity, params.mapping);
  const mapped = runtime.channelSessionAssignments.get(channelKey);
  const sessionId = mapped ?? channelKey;
  ensureSession(runtime, sessionId, {
    title: params.title,
    origin: createChannelSessionOrigin(params.identity)
  });
  if (!mapped) {
    runtime.channelSessionAssignments.set(channelKey, sessionId);
  }
  return sessionId;
}

export function listPersistedSessionIds(runtime: any): string[] {
  if (!runtime.sessionStoreEnabled) {
    return [];
  }
  return listSessionIds(runtime.sessionDirectory);
}

export function listContinuityJobs(runtime: any, limit = 20): unknown[] {
  if (!runtime.continuityRuntime) {
    return [];
  }
  return runtime.continuityRuntime.listJobs(limit);
}
