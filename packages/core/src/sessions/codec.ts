import path from "node:path";
import type { ChatMessage } from "../types.js";
import {
  type SessionEventLine,
  type SessionIndexEntry,
  type SessionIndexLine,
  type SessionMessageLine
} from "./types.js";
import { sessionFullPath, sessionTranscriptPath } from "./paths.js";
import { isChatRole, normalizeOrigin, nowIso, safeDate } from "./utils.js";

export function toIndexLine(entry: SessionIndexEntry, sessionDirectory: string): SessionIndexLine {
  return {
    version: 1,
    type: "session_index",
    ...entry,
    transcriptFile: path.basename(sessionTranscriptPath(sessionDirectory, entry.sessionId)),
    fullFile: path.basename(sessionFullPath(sessionDirectory, entry.sessionId))
  };
}

export function parseIndexLine(value: unknown): SessionIndexEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "session_index") {
    return null;
  }

  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) {
    return null;
  }

  const createdAt = safeDate(record.createdAt) ?? nowIso();
  const lastActivityAt = safeDate(record.lastActivityAt) ?? createdAt;
  const updatedAt = safeDate(record.updatedAt) ?? lastActivityAt;

  const entry: SessionIndexEntry = {
    sessionId,
    activeProviderId: typeof record.activeProviderId === "string" ? record.activeProviderId : undefined,
    pendingProviderId: typeof record.pendingProviderId === "string" ? record.pendingProviderId : undefined,
    historyCount:
      typeof record.historyCount === "number" && Number.isFinite(record.historyCount) && record.historyCount >= 0
        ? Math.floor(record.historyCount)
        : 0,
    revision:
      typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision >= 0
        ? Math.floor(record.revision)
        : 0,
    updatedAt,
    createdAt,
    lastActivityAt
  };

  if (typeof record.title === "string" && record.title.trim().length > 0) {
    entry.title = record.title.trim();
  }
  const origin = normalizeOrigin(record.origin);
  if (origin) {
    entry.origin = origin;
  }
  if (typeof record.providerRouteId === "string" && record.providerRouteId.trim().length > 0) {
    entry.providerRouteId = record.providerRouteId.trim();
  }
  if (
    record.skillInjectionMode === "off" ||
    record.skillInjectionMode === "all" ||
    record.skillInjectionMode === "relevant"
  ) {
    entry.skillInjectionMode = record.skillInjectionMode;
  }
  return entry;
}

export function parseSessionMessageLine(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "message") {
    return null;
  }
  if (!isChatRole(record.role) || typeof record.content !== "string") {
    return null;
  }

  const createdAt = safeDate(record.createdAt) ?? nowIso();
  return {
    role: record.role,
    content: record.content,
    createdAt
  };
}

export function parseSessionEventLine(value: unknown): SessionEventLine | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "event") {
    return null;
  }

  const eventType = typeof record.eventType === "string" ? record.eventType.trim() : "";
  if (!eventType) {
    return null;
  }

  return {
    version: 1,
    type: "event",
    eventType,
    timestamp: safeDate(record.timestamp) ?? nowIso(),
    payload: record.payload
  };
}

export function toSessionMessageLines(history: ChatMessage[]): SessionMessageLine[] {
  const lines: SessionMessageLine[] = [];
  for (const message of history) {
    if (!isChatRole(message.role) || typeof message.content !== "string") {
      continue;
    }
    lines.push({
      version: 1,
      type: "message",
      role: message.role,
      content: message.content,
      createdAt: safeDate(message.createdAt) ?? nowIso()
    });
  }
  return lines;
}

export function serializeMessageLines(lines: SessionMessageLine[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
