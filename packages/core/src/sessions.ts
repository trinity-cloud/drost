import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./types.js";

const SESSION_INDEX_FILE = ".drost-sessions-index.jsonl";
const SESSION_INDEX_LOCK_FILE = ".drost-sessions-index.lock";
const SESSION_CORRUPT_DIR = ".drost-sessions-corrupt";
const SESSION_ARCHIVE_DIR = ".drost-sessions-archive";

const SESSION_TRANSCRIPT_SUFFIX = ".jsonl";
const SESSION_FULL_SUFFIX = ".full.jsonl";

const DEFAULT_LOCK_TIMEOUT_MS = 600;
const DEFAULT_LOCK_STALE_MS = 30_000;

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

interface SessionIndexLine extends SessionIndexEntry {
  version: 1;
  type: "session_index";
  transcriptFile: string;
  fullFile: string;
}

interface SessionMessageLine {
  version: 1;
  type: "message";
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
}

interface SessionEventLine {
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

function nowIso(): string {
  return new Date().toISOString();
}

function sleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function sanitizeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new SessionStoreError("invalid_session", "Session id is required");
  }
  return normalized;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sessionIndexPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_INDEX_FILE);
}

function sessionIndexLockPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_INDEX_LOCK_FILE);
}

function sessionCorruptDirectoryPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_CORRUPT_DIR);
}

function sessionArchiveDirectoryPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_ARCHIVE_DIR);
}

function sessionTranscriptPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}${SESSION_TRANSCRIPT_SUFFIX}`);
}

function sessionFullPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}${SESSION_FULL_SUFFIX}`);
}

function sessionLockPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}.lock`);
}

function safeDate(value: unknown): string | null {
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

function normalizeOrigin(value: unknown): SessionOriginIdentity | undefined {
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

function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function normalizeMetadata(params: {
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

function toLoadedSessionRecord(params: {
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

function toIndexEntry(record: LoadedSessionRecord): SessionIndexEntry {
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

function toIndexLine(entry: SessionIndexEntry, sessionDirectory: string): SessionIndexLine {
  return {
    version: 1,
    type: "session_index",
    ...entry,
    transcriptFile: path.basename(sessionTranscriptPath(sessionDirectory, entry.sessionId)),
    fullFile: path.basename(sessionFullPath(sessionDirectory, entry.sessionId))
  };
}

function parseIndexLine(value: unknown): SessionIndexEntry | null {
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

function parseSessionMessageLine(value: unknown): ChatMessage | null {
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

function parseSessionEventLine(value: unknown): SessionEventLine | null {
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

function withLock<T>(
  lockFilePath: string,
  options: SessionStoreLockOptions | undefined,
  run: () => T
): T {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const started = Date.now();
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFilePath, "wx");
      fs.writeFileSync(fd, `${process.pid}:${Date.now()}`);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw new SessionStoreError("io_error", err.message || String(error));
      }

      try {
        const stat = fs.statSync(lockFilePath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockFilePath, { force: true });
          continue;
        }
      } catch {
        // best effort stale lock cleanup; continue acquire loop
      }

      if (Date.now() - started >= timeoutMs) {
        throw new SessionStoreError("lock_conflict", `Session lock timeout: ${path.basename(lockFilePath)}`);
      }
      sleepMs(15);
    }
  }

  try {
    return run();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(lockFilePath, { force: true });
    } catch {
      // best effort
    }
  }
}

function writeTextAtomic(filePath: string, content: string): void {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
  }
}

function appendText(filePath: string, content: string): void {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, content, "utf8");
}

function readIndexUnlocked(sessionDirectory: string): SessionIndexEntry[] {
  const filePath = sessionIndexPath(sessionDirectory);
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const bySession = new Map<string, SessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const entry = parseIndexLine(parsed);
      if (!entry) {
        continue;
      }
      bySession.set(entry.sessionId, entry);
    } catch {
      // ignore corrupt lines in index; per-session load will self-heal on save
    }
  }

  return Array.from(bySession.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function writeIndexUnlocked(sessionDirectory: string, entries: SessionIndexEntry[]): void {
  const deduped = new Map<string, SessionIndexEntry>();
  for (const entry of entries) {
    deduped.set(entry.sessionId, entry);
  }
  const normalized = Array.from(deduped.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const lines = normalized.map((entry) => JSON.stringify(toIndexLine(entry, sessionDirectory)));
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  writeTextAtomic(sessionIndexPath(sessionDirectory), body);
}

function mutateIndex(
  sessionDirectory: string,
  lockOptions: SessionStoreLockOptions | undefined,
  mutate: (entries: SessionIndexEntry[]) => SessionIndexEntry[]
): SessionIndexEntry[] {
  ensureDirectory(sessionDirectory);
  return withLock(sessionIndexLockPath(sessionDirectory), lockOptions, () => {
    const current = readIndexUnlocked(sessionDirectory);
    const next = mutate(current);
    writeIndexUnlocked(sessionDirectory, next);
    return next;
  });
}

function quarantineFile(params: {
  sessionDirectory: string;
  sessionId: string;
  sourceFilePath: string;
}): string | undefined {
  try {
    const corruptDir = sessionCorruptDirectoryPath(params.sessionDirectory);
    ensureDirectory(corruptDir);
    const ext = path.extname(params.sourceFilePath);
    const target = path.join(
      corruptDir,
      `${sanitizeSessionId(params.sessionId)}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext || ".jsonl"}`
    );
    fs.renameSync(params.sourceFilePath, target);
    return target;
  } catch {
    return undefined;
  }
}

function readSessionMessagesFromJsonl(filePath: string): {
  ok: true;
  history: ChatMessage[];
} | {
  ok: false;
  code: SessionLoadDiagnosticCode;
  message: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: true,
        history: []
      };
    }
    return {
      ok: false,
      code: "invalid_shape",
      message: err.message || String(error)
    };
  }

  const history: ChatMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        ok: false,
        code: "corrupt_json",
        message: error instanceof Error ? error.message : String(error)
      };
    }
    const message = parseSessionMessageLine(parsed);
    if (message) {
      history.push(message);
      continue;
    }

    const eventLine = parseSessionEventLine(parsed);
    if (eventLine) {
      continue;
    }

    return {
      ok: false,
      code: "invalid_shape",
      message: "Session JSONL line has invalid shape"
    };
  }

  return {
    ok: true,
    history
  };
}

function toSessionMessageLines(history: ChatMessage[]): SessionMessageLine[] {
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

function serializeMessageLines(lines: SessionMessageLine[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function readSerializedEventLines(filePath: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const serialized: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const eventLine = parseSessionEventLine(parsed);
      if (!eventLine) {
        continue;
      }
      serialized.push(JSON.stringify(eventLine));
    } catch {
      // ignore invalid event lines while preserving readable event log
    }
  }
  return serialized;
}

function isHistoryPrefix(previous: ChatMessage[], next: ChatMessage[]): boolean {
  if (previous.length > next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) {
      return false;
    }
    if (left.role !== right.role || left.content !== right.content || left.createdAt !== right.createdAt) {
      return false;
    }
  }
  return true;
}

function resolveIndexEntry(
  sessionDirectory: string,
  sessionId: string,
  entries?: SessionIndexEntry[]
): SessionIndexEntry | undefined {
  const source = entries ?? readIndexUnlocked(sessionDirectory);
  return source.find((entry) => entry.sessionId === sessionId);
}

function deriveSessionFilesFromEntry(
  sessionDirectory: string,
  sessionId: string,
  entry?: SessionIndexEntry
): { transcriptPath: string; fullPath: string } {
  const transcriptPath = sessionTranscriptPath(sessionDirectory, sessionId);
  const fullPath = sessionFullPath(sessionDirectory, sessionId);
  if (!entry) {
    return {
      transcriptPath,
      fullPath
    };
  }
  return {
    transcriptPath,
    fullPath
  };
}

function loadSessionRecordUnlocked(
  sessionDirectory: string,
  sessionId: string,
  entries?: SessionIndexEntry[]
): SessionLoadResult {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const entry = resolveIndexEntry(sessionDirectory, normalizedSessionId, entries);
  const files = deriveSessionFilesFromEntry(sessionDirectory, normalizedSessionId, entry);

  const loaded = readSessionMessagesFromJsonl(files.fullPath);
  if (!loaded.ok) {
    if (loaded.code === "corrupt_json" || loaded.code === "invalid_shape") {
      const quarantinedPath = quarantineFile({
        sessionDirectory,
        sessionId: normalizedSessionId,
        sourceFilePath: files.fullPath
      });
      try {
        fs.rmSync(files.transcriptPath, { force: true });
      } catch {
        // best effort
      }
      mutateIndex(sessionDirectory, undefined, (all) =>
        all.filter((candidate) => candidate.sessionId !== normalizedSessionId)
      );
      return {
        record: null,
        diagnostics: [
          {
            code: loaded.code,
            message: loaded.message,
            quarantinedPath
          }
        ]
      };
    }
  }

  if (!loaded.ok) {
    return {
      record: null,
      diagnostics: [
        {
          code: loaded.code,
          message: loaded.message
        }
      ]
    };
  }

  if (!entry && loaded.history.length === 0) {
    return {
      record: null
    };
  }

  const fallbackNow = nowIso();
  const metadata = normalizeMetadata({
    raw: entry,
    history: loaded.history,
    fallbackNow,
    previous: undefined
  });

  const record = toLoadedSessionRecord({
    sessionId: normalizedSessionId,
    activeProviderId: entry?.activeProviderId,
    pendingProviderId: entry?.pendingProviderId,
    history: loaded.history,
    metadata,
    revision: entry?.revision ?? 0,
    updatedAt: safeDate(entry?.updatedAt) ?? metadata.lastActivityAt
  });

  return {
    record
  };
}

export function loadSessionRecordWithDiagnostics(
  sessionDirectory: string,
  sessionId: string
): SessionLoadResult {
  try {
    return loadSessionRecordUnlocked(sessionDirectory, sessionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        record: null
      };
    }
    return {
      record: null,
      diagnostics: [
        {
          code: "invalid_shape",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

export function loadSessionRecord(
  sessionDirectory: string,
  sessionId: string
): LoadedSessionRecord | null {
  return loadSessionRecordWithDiagnostics(sessionDirectory, sessionId).record;
}

export function listSessionIndex(sessionDirectory: string): SessionIndexEntry[] {
  return readIndexUnlocked(sessionDirectory);
}

export function saveSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  history: ChatMessage[];
  metadata?: Partial<SessionMetadata>;
  lock?: SessionStoreLockOptions;
}): LoadedSessionRecord {
  const normalizedSessionId = normalizeSessionId(params.sessionId);
  ensureDirectory(params.sessionDirectory);

  const lockPath = sessionLockPath(params.sessionDirectory, normalizedSessionId);
  return withLock(lockPath, params.lock, () => {
    const indexEntries = readIndexUnlocked(params.sessionDirectory);
    const existingEntry = resolveIndexEntry(params.sessionDirectory, normalizedSessionId, indexEntries);
    const files = deriveSessionFilesFromEntry(params.sessionDirectory, normalizedSessionId, existingEntry);

    const previousLoaded = loadSessionRecordUnlocked(params.sessionDirectory, normalizedSessionId, indexEntries);
    const previous = previousLoaded.record ?? undefined;

    const fallbackNow = nowIso();
    const metadata = normalizeMetadata({
      raw: existingEntry,
      history: params.history,
      fallbackNow,
      previous: previous?.metadata,
      override: params.metadata
    });
    const updatedAt = metadata.lastActivityAt || fallbackNow;
    const revision = (existingEntry?.revision ?? 0) + 1;

    const nextHistory = params.history.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: safeDate(message.createdAt) ?? nowIso()
    }));

    const previousHistory = previous?.history ?? [];
    const nextFullLines = toSessionMessageLines(nextHistory);

    if (isHistoryPrefix(previousHistory, nextHistory)) {
      const appended = nextHistory.slice(previousHistory.length);
      if (appended.length > 0) {
        appendText(files.fullPath, serializeMessageLines(toSessionMessageLines(appended)));
      } else if (!fs.existsSync(files.fullPath)) {
        writeTextAtomic(files.fullPath, serializeMessageLines(nextFullLines));
      }
    } else {
      const preservedEventLines = readSerializedEventLines(files.fullPath);
      const eventPrefix = preservedEventLines.length > 0 ? `${preservedEventLines.join("\n")}\n` : "";
      writeTextAtomic(files.fullPath, `${eventPrefix}${serializeMessageLines(nextFullLines)}`);
    }

    const nextTranscriptHistory = nextHistory.filter(
      (message) => message.role === "user" || message.role === "assistant"
    );
    const previousTranscriptHistory = previousHistory.filter(
      (message) => message.role === "user" || message.role === "assistant"
    );

    if (isHistoryPrefix(previousTranscriptHistory, nextTranscriptHistory)) {
      const appendedTranscript = nextTranscriptHistory.slice(previousTranscriptHistory.length);
      if (appendedTranscript.length > 0) {
        appendText(files.transcriptPath, serializeMessageLines(toSessionMessageLines(appendedTranscript)));
      } else if (!fs.existsSync(files.transcriptPath)) {
        writeTextAtomic(files.transcriptPath, serializeMessageLines(toSessionMessageLines(nextTranscriptHistory)));
      }
    } else {
      writeTextAtomic(files.transcriptPath, serializeMessageLines(toSessionMessageLines(nextTranscriptHistory)));
    }

    const saved = toLoadedSessionRecord({
      sessionId: normalizedSessionId,
      activeProviderId: params.activeProviderId,
      pendingProviderId: params.pendingProviderId,
      history: nextHistory,
      metadata,
      revision,
      updatedAt
    });

    mutateIndex(params.sessionDirectory, params.lock, (entries) => {
      const next = entries.filter((entry) => entry.sessionId !== normalizedSessionId);
      next.push(toIndexEntry(saved));
      return next;
    });

    return saved;
  });
}

export function appendSessionEventRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  eventType: string;
  payload?: unknown;
  timestamp?: string;
  lock?: SessionStoreLockOptions;
}): void {
  const sessionId = normalizeSessionId(params.sessionId);
  const eventType = params.eventType.trim();
  if (!eventType) {
    return;
  }

  const lockPath = sessionLockPath(params.sessionDirectory, sessionId);
  withLock(lockPath, params.lock, () => {
    const fullPath = sessionFullPath(params.sessionDirectory, sessionId);
    const line: SessionEventLine = {
      version: 1,
      type: "event",
      eventType,
      timestamp: safeDate(params.timestamp) ?? nowIso(),
      payload: params.payload
    };
    appendText(fullPath, `${JSON.stringify(line)}\n`);
  });
}

export function deleteSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  lock?: SessionStoreLockOptions;
}): boolean {
  const normalizedSessionId = normalizeSessionId(params.sessionId);
  const files = {
    transcriptPath: sessionTranscriptPath(params.sessionDirectory, normalizedSessionId),
    fullPath: sessionFullPath(params.sessionDirectory, normalizedSessionId)
  };
  const lockPath = sessionLockPath(params.sessionDirectory, normalizedSessionId);

  const removed = withLock(lockPath, params.lock, () => {
    const hadTranscript = fs.existsSync(files.transcriptPath);
    const hadFull = fs.existsSync(files.fullPath);
    try {
      fs.rmSync(files.transcriptPath, { force: true });
      fs.rmSync(files.fullPath, { force: true });
    } catch {
      // best effort
    }
    return hadTranscript || hadFull;
  });

  mutateIndex(params.sessionDirectory, params.lock, (entries) =>
    entries.filter((entry) => entry.sessionId !== normalizedSessionId)
  );

  return removed;
}

export function renameSessionRecord(params: {
  sessionDirectory: string;
  fromSessionId: string;
  toSessionId: string;
  overwrite?: boolean;
  lock?: SessionStoreLockOptions;
}): LoadedSessionRecord {
  const fromSessionId = normalizeSessionId(params.fromSessionId);
  const toSessionId = normalizeSessionId(params.toSessionId);

  if (fromSessionId === toSessionId) {
    const existing = loadSessionRecord(params.sessionDirectory, fromSessionId);
    if (!existing) {
      throw new SessionStoreError("not_found", `Unknown session: ${fromSessionId}`);
    }
    return existing;
  }

  const lockPaths = [
    sessionLockPath(params.sessionDirectory, fromSessionId),
    sessionLockPath(params.sessionDirectory, toSessionId)
  ].sort((left, right) => left.localeCompare(right));

  const runRename = (): LoadedSessionRecord => {
    const entries = readIndexUnlocked(params.sessionDirectory);
    const sourceEntry = resolveIndexEntry(params.sessionDirectory, fromSessionId, entries);
    if (!sourceEntry) {
      throw new SessionStoreError("not_found", `Unknown session: ${fromSessionId}`);
    }

    const targetEntry = resolveIndexEntry(params.sessionDirectory, toSessionId, entries);
    if (targetEntry && !params.overwrite) {
      throw new SessionStoreError("already_exists", `Session already exists: ${toSessionId}`);
    }

    const sourceFiles = deriveSessionFilesFromEntry(params.sessionDirectory, fromSessionId, sourceEntry);
    const targetFiles = {
      transcriptPath: sessionTranscriptPath(params.sessionDirectory, toSessionId),
      fullPath: sessionFullPath(params.sessionDirectory, toSessionId)
    };

    const loaded = loadSessionRecordUnlocked(params.sessionDirectory, fromSessionId, entries);
    if (!loaded.record) {
      throw new SessionStoreError("not_found", `Unknown session: ${fromSessionId}`);
    }

    if (params.overwrite) {
      try {
        fs.rmSync(targetFiles.transcriptPath, { force: true });
        fs.rmSync(targetFiles.fullPath, { force: true });
      } catch {
        // best effort
      }
    } else if (fs.existsSync(targetFiles.transcriptPath) || fs.existsSync(targetFiles.fullPath)) {
      throw new SessionStoreError("already_exists", `Session already exists: ${toSessionId}`);
    }

    if (fs.existsSync(sourceFiles.transcriptPath)) {
      fs.renameSync(sourceFiles.transcriptPath, targetFiles.transcriptPath);
    }
    if (fs.existsSync(sourceFiles.fullPath)) {
      fs.renameSync(sourceFiles.fullPath, targetFiles.fullPath);
    }

    const renamed: LoadedSessionRecord = {
      ...loaded.record,
      sessionId: toSessionId,
      revision: loaded.record.revision + 1,
      updatedAt: nowIso()
    };

    mutateIndex(params.sessionDirectory, params.lock, (allEntries) => {
      const next = allEntries.filter((entry) => entry.sessionId !== fromSessionId && entry.sessionId !== toSessionId);
      next.push(toIndexEntry(renamed));
      return next;
    });

    return renamed;
  };

  return withLock(lockPaths[0]!, params.lock, () =>
    withLock(lockPaths[1]!, params.lock, () => runRename())
  );
}

export function exportSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
}): LoadedSessionRecord | null {
  return loadSessionRecord(params.sessionDirectory, params.sessionId);
}

export function importSessionRecord(params: {
  sessionDirectory: string;
  record: LoadedSessionRecord;
  overwrite?: boolean;
  lock?: SessionStoreLockOptions;
}): LoadedSessionRecord {
  const normalizedSessionId = normalizeSessionId(params.record.sessionId);
  const existing = loadSessionRecord(params.sessionDirectory, normalizedSessionId);
  if (!params.overwrite && existing) {
    throw new SessionStoreError("already_exists", `Session already exists: ${normalizedSessionId}`);
  }

  return saveSessionRecord({
    sessionDirectory: params.sessionDirectory,
    sessionId: normalizedSessionId,
    activeProviderId: params.record.activeProviderId,
    pendingProviderId: params.record.pendingProviderId,
    history: params.record.history,
    metadata: params.record.metadata,
    lock: params.lock
  });
}

export function archiveSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  lock?: SessionStoreLockOptions;
}): { archivedPath: string } | null {
  const sessionId = normalizeSessionId(params.sessionId);
  const lockPath = sessionLockPath(params.sessionDirectory, sessionId);

  return withLock(lockPath, params.lock, () => {
    const entry = resolveIndexEntry(params.sessionDirectory, sessionId);
    const files = deriveSessionFilesFromEntry(params.sessionDirectory, sessionId, entry);
    if (!fs.existsSync(files.transcriptPath) && !fs.existsSync(files.fullPath)) {
      return null;
    }

    const archiveDir = sessionArchiveDirectoryPath(params.sessionDirectory);
    ensureDirectory(archiveDir);

    const archiveToken = `${sanitizeSessionId(sessionId)}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const archivedTranscriptPath = path.join(archiveDir, `${archiveToken}${SESSION_TRANSCRIPT_SUFFIX}`);
    const archivedFullPath = path.join(archiveDir, `${archiveToken}${SESSION_FULL_SUFFIX}`);

    if (fs.existsSync(files.transcriptPath)) {
      fs.renameSync(files.transcriptPath, archivedTranscriptPath);
    }
    if (fs.existsSync(files.fullPath)) {
      fs.renameSync(files.fullPath, archivedFullPath);
    }

    mutateIndex(params.sessionDirectory, params.lock, (entries) =>
      entries.filter((candidate) => candidate.sessionId !== sessionId)
    );

    return {
      archivedPath: fs.existsSync(archivedFullPath) ? archivedFullPath : archivedTranscriptPath
    };
  });
}

function totalCharacterCount(history: ChatMessage[]): number {
  let total = 0;
  for (const message of history) {
    total += message.content.length;
  }
  return total;
}

function trimToMaxMessages(history: ChatMessage[], maxMessages: number, preserveSystemMessages: boolean): ChatMessage[] {
  if (history.length <= maxMessages) {
    return history;
  }

  if (!preserveSystemMessages || maxMessages <= 0) {
    return history.slice(-Math.max(0, maxMessages));
  }

  let leadSystemCount = 0;
  while (leadSystemCount < history.length && history[leadSystemCount]?.role === "system") {
    leadSystemCount += 1;
  }

  const fixedSystem = history.slice(0, Math.min(leadSystemCount, maxMessages));
  const tailSlots = Math.max(0, maxMessages - fixedSystem.length);
  const tailSource = history.slice(leadSystemCount);
  const tail = tailSource.slice(-tailSlots);
  return [...fixedSystem, ...tail];
}

function trimToMaxChars(history: ChatMessage[], maxChars: number, preserveSystemMessages: boolean): SessionHistoryBudgetResult {
  if (maxChars <= 0) {
    const droppedCharacters = totalCharacterCount(history);
    return {
      history: [],
      trimmed: history.length > 0,
      droppedMessages: history.length,
      droppedCharacters
    };
  }

  const kept = [...history];
  let droppedMessages = 0;
  let droppedCharacters = 0;
  while (totalCharacterCount(kept) > maxChars && kept.length > 0) {
    let dropIndex = 0;
    if (preserveSystemMessages) {
      const firstNonSystem = kept.findIndex((message) => message.role !== "system");
      if (firstNonSystem >= 0) {
        dropIndex = firstNonSystem;
      }
    }
    const [removed] = kept.splice(dropIndex, 1);
    if (removed) {
      droppedMessages += 1;
      droppedCharacters += removed.content.length;
    }
  }

  return {
    history: kept,
    trimmed: droppedMessages > 0,
    droppedMessages,
    droppedCharacters
  };
}

export function applySessionHistoryBudget(params: {
  sessionId?: string;
  history: ChatMessage[];
  policy?: SessionHistoryBudgetPolicy;
}): SessionHistoryBudgetResult {
  const policy = params.policy;
  if (!policy || policy.enabled === false) {
    return {
      history: [...params.history],
      trimmed: false,
      droppedMessages: 0,
      droppedCharacters: 0
    };
  }

  let working = [...params.history];
  if (typeof policy.summarize === "function") {
    try {
      const summarized = policy.summarize({
        sessionId: params.sessionId,
        history: [...working]
      });
      if (Array.isArray(summarized)) {
        working = summarized.filter((message): message is ChatMessage => {
          return (
            message &&
            typeof message === "object" &&
            isChatRole(message.role) &&
            typeof message.content === "string" &&
            typeof message.createdAt === "string"
          );
        });
      }
    } catch {
      // summarize hook is best effort
    }
  }

  const preserveSystemMessages = policy.preserveSystemMessages ?? true;
  let droppedMessages = 0;
  let droppedCharacters = 0;
  if (typeof policy.maxMessages === "number" && Number.isFinite(policy.maxMessages) && policy.maxMessages >= 0) {
    const before = working;
    working = trimToMaxMessages(working, Math.floor(policy.maxMessages), preserveSystemMessages);
    droppedMessages += Math.max(0, before.length - working.length);
    droppedCharacters += Math.max(0, totalCharacterCount(before) - totalCharacterCount(working));
  }

  if (typeof policy.maxChars === "number" && Number.isFinite(policy.maxChars) && policy.maxChars >= 0) {
    const charTrim = trimToMaxChars(working, Math.floor(policy.maxChars), preserveSystemMessages);
    working = charTrim.history;
    droppedMessages += charTrim.droppedMessages;
    droppedCharacters += charTrim.droppedCharacters;
  }

  return {
    history: working,
    trimmed: droppedMessages > 0 || droppedCharacters > 0,
    droppedMessages,
    droppedCharacters
  };
}

export function listSessionIds(sessionDirectory: string): string[] {
  const indexed = listSessionIndex(sessionDirectory);
  if (indexed.length > 0) {
    return indexed.map((entry) => entry.sessionId).sort((left, right) => left.localeCompare(right));
  }

  let files: string[];
  try {
    files = fs.readdirSync(sessionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }

  return files
    .filter((entry) => entry.endsWith(SESSION_FULL_SUFFIX))
    .map((entry) => {
      const encoded = entry.slice(0, -SESSION_FULL_SUFFIX.length);
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}
