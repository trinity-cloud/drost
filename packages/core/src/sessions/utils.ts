import fs from "node:fs";
import type { ChatMessage } from "../types.js";
import {
  type LoadedSessionRecord,
  type SessionIndexEntry,
  type SessionMetadata,
  type SessionOriginIdentity,
  SessionStoreError
} from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

export function sanitizeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new SessionStoreError("invalid_session", "Session id is required");
  }
  return normalized;
}

export function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function safeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function latestHistoryTimestamp(history: ChatMessage[]): string | null {
  let latest: number | null = null;
  for (const message of history) {
    const parsed = Date.parse(message.createdAt);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    if (latest === null || parsed > latest) {
      latest = parsed;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function normalizeOrigin(value: unknown): SessionOriginIdentity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const channel = typeof record.channel === "string" ? record.channel.trim() : "";
  if (!channel) {
    return undefined;
  }

  const origin: SessionOriginIdentity = {
    channel
  };
  if (typeof record.workspaceId === "string" && record.workspaceId.trim().length > 0) {
    origin.workspaceId = record.workspaceId.trim();
  }
  if (typeof record.accountId === "string" && record.accountId.trim().length > 0) {
    origin.accountId = record.accountId.trim();
  }
  if (typeof record.chatId === "string" && record.chatId.trim().length > 0) {
    origin.chatId = record.chatId.trim();
  }
  if (typeof record.userId === "string" && record.userId.trim().length > 0) {
    origin.userId = record.userId.trim();
  }
  if (typeof record.threadId === "string" && record.threadId.trim().length > 0) {
    origin.threadId = record.threadId.trim();
  }
  return origin;
}

export function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function normalizeMetadata(params: {
  raw: unknown;
  history: ChatMessage[];
  fallbackNow: string;
  previous?: SessionMetadata;
  override?: Partial<SessionMetadata>;
}): SessionMetadata {
  const raw = params.raw && typeof params.raw === "object" ? (params.raw as Record<string, unknown>) : {};
  const previous = params.previous;

  const createdAt =
    safeDate(params.override?.createdAt) ??
    safeDate(raw.createdAt) ??
    safeDate(previous?.createdAt) ??
    latestHistoryTimestamp(params.history) ??
    params.fallbackNow;
  const lastActivityAt =
    safeDate(params.override?.lastActivityAt) ??
    safeDate(raw.lastActivityAt) ??
    latestHistoryTimestamp(params.history) ??
    safeDate(previous?.lastActivityAt) ??
    createdAt;

  const titleCandidate =
    typeof params.override?.title === "string"
      ? params.override.title.trim()
      : typeof raw.title === "string"
        ? raw.title.trim()
        : typeof previous?.title === "string"
          ? previous.title.trim()
          : "";

  const metadata: SessionMetadata = {
    createdAt,
    lastActivityAt
  };
  if (titleCandidate.length > 0) {
    metadata.title = titleCandidate;
  }

  const origin = params.override?.origin ?? normalizeOrigin(raw.origin) ?? previous?.origin;
  if (origin) {
    metadata.origin = origin;
  }
  const routeIdCandidate =
    typeof params.override?.providerRouteId === "string"
      ? params.override.providerRouteId.trim()
      : typeof raw.providerRouteId === "string"
        ? raw.providerRouteId.trim()
        : typeof previous?.providerRouteId === "string"
          ? previous.providerRouteId.trim()
          : "";
  if (routeIdCandidate.length > 0) {
    metadata.providerRouteId = routeIdCandidate;
  }
  const skillInjectionModeCandidate =
    params.override?.skillInjectionMode ??
    (raw.skillInjectionMode === "off" || raw.skillInjectionMode === "all" || raw.skillInjectionMode === "relevant"
      ? raw.skillInjectionMode
      : previous?.skillInjectionMode);
  if (
    skillInjectionModeCandidate === "off" ||
    skillInjectionModeCandidate === "all" ||
    skillInjectionModeCandidate === "relevant"
  ) {
    metadata.skillInjectionMode = skillInjectionModeCandidate;
  }

  return metadata;
}

export function toLoadedSessionRecord(params: {
  sessionId: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  history: ChatMessage[];
  metadata: SessionMetadata;
  revision: number;
  updatedAt: string;
}): LoadedSessionRecord {
  return {
    sessionId: params.sessionId,
    activeProviderId: params.activeProviderId,
    pendingProviderId: params.pendingProviderId,
    history: params.history,
    metadata: params.metadata,
    revision: params.revision,
    updatedAt: params.updatedAt
  };
}

export function toIndexEntry(record: LoadedSessionRecord): SessionIndexEntry {
  return {
    sessionId: record.sessionId,
    activeProviderId: record.activeProviderId,
    pendingProviderId: record.pendingProviderId,
    historyCount: record.history.length,
    revision: record.revision,
    updatedAt: record.updatedAt,
    createdAt: record.metadata.createdAt,
    lastActivityAt: record.metadata.lastActivityAt,
    title: record.metadata.title,
    origin: record.metadata.origin,
    providerRouteId: record.metadata.providerRouteId,
    skillInjectionMode: record.metadata.skillInjectionMode
  };
}
