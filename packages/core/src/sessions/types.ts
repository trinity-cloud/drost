import type { ChatMessage } from "../types.js";

export interface SessionOriginIdentity {
  channel: string;
  workspaceId?: string;
  accountId?: string;
  chatId?: string;
  userId?: string;
  threadId?: string;
}

export interface SessionMetadata {
  createdAt: string;
  lastActivityAt: string;
  title?: string;
  origin?: SessionOriginIdentity;
  providerRouteId?: string;
  skillInjectionMode?: "off" | "all" | "relevant";
}

export interface LoadedSessionRecord {
  sessionId: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  history: ChatMessage[];
  metadata: SessionMetadata;
  revision: number;
  updatedAt: string;
}

export interface SessionIndexEntry {
  sessionId: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  historyCount: number;
  revision: number;
  updatedAt: string;
  createdAt: string;
  lastActivityAt: string;
  title?: string;
  origin?: SessionOriginIdentity;
  providerRouteId?: string;
  skillInjectionMode?: "off" | "all" | "relevant";
}

export interface SessionIndexLine extends SessionIndexEntry {
  version: 1;
  type: "session_index";
  transcriptFile: string;
  fullFile: string;
}

export interface SessionMessageLine {
  version: 1;
  type: "message";
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
}

export interface SessionEventLine {
  version: 1;
  type: "event";
  eventType: string;
  timestamp: string;
  payload: unknown;
}

export type SessionLoadDiagnosticCode = "corrupt_json" | "invalid_shape";

export interface SessionLoadDiagnostic {
  code: SessionLoadDiagnosticCode;
  message: string;
  quarantinedPath?: string;
}

export interface SessionLoadResult {
  record: LoadedSessionRecord | null;
  diagnostics?: SessionLoadDiagnostic[];
}

export type SessionStoreErrorCode =
  | "lock_conflict"
  | "io_error"
  | "not_found"
  | "already_exists"
  | "invalid_session";

export class SessionStoreError extends Error {
  constructor(
    public readonly code: SessionStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export interface SessionStoreLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

export interface SessionHistoryBudgetPolicy {
  enabled?: boolean;
  maxMessages?: number;
  maxChars?: number;
  preserveSystemMessages?: boolean;
  summarize?: (params: { sessionId?: string; history: ChatMessage[] }) => ChatMessage[];
}

export interface SessionHistoryBudgetResult {
  history: ChatMessage[];
  trimmed: boolean;
  droppedMessages: number;
  droppedCharacters: number;
}
