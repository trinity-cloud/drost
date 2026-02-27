import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./types.js";

const SESSION_INDEX_FILE = ".drost-sessions-index.json";
const SESSION_INDEX_LOCK_FILE = ".drost-sessions-index.lock";
const SESSION_CORRUPT_DIR = ".drost-sessions-corrupt";
const SESSION_ARCHIVE_DIR = ".drost-sessions-archive";

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

type SessionRecordV2 = {
  version: 2;
  sessionId: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  history: ChatMessage[];
  metadata: SessionMetadata;
  revision: number;
  updatedAt: string;
};

type SessionRecordV1 = {
  version?: 1;
  sessionId?: string;
  activeProviderId?: string;
  pendingProviderId?: string;
  history?: unknown;
  updatedAt?: string;
};

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
}

interface SessionIndexFile {
  version: 1;
  updatedAt: string;
  sessions: SessionIndexEntry[];
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

function sessionFilePath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}.json`);
}

function sessionLockPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}.lock`);
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

function parseHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (!isChatRole(record.role) || typeof record.content !== "string") {
      continue;
    }
    const createdAt = safeDate(record.createdAt) ?? nowIso();
    messages.push({
      role: record.role,
      content: record.content,
      createdAt
    });
  }
  return messages;
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

function parseSessionRecord(params: {
  raw: unknown;
  requestedSessionId: string;
}): LoadedSessionRecord | null {
  if (!params.raw || typeof params.raw !== "object") {
    return null;
  }
  const record = params.raw as Record<string, unknown>;
  const history = parseHistory(record.history);
  const fallbackNow = nowIso();

  if (record.version === 2) {
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim().length > 0
        ? record.sessionId.trim()
        : params.requestedSessionId;
    const revision =
      typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision >= 0
        ? Math.floor(record.revision)
        : 0;
    const metadata = normalizeMetadata({
      raw: record.metadata,
      history,
      fallbackNow
    });
    const updatedAt = safeDate(record.updatedAt) ?? metadata.lastActivityAt;
    return toLoadedSessionRecord({
      sessionId,
      activeProviderId: typeof record.activeProviderId === "string" ? record.activeProviderId : undefined,
      pendingProviderId: typeof record.pendingProviderId === "string" ? record.pendingProviderId : undefined,
      history,
      metadata,
      revision,
      updatedAt
    });
  }

  const hasLegacyFields =
    typeof record.activeProviderId === "string" ||
    typeof record.pendingProviderId === "string" ||
    Array.isArray(record.history) ||
    typeof record.updatedAt === "string" ||
    typeof record.sessionId === "string";
  const isLegacyVersion = record.version === undefined || record.version === 1;
  if (!isLegacyVersion || !hasLegacyFields) {
    return null;
  }

  const legacy = record as SessionRecordV1;
  const metadata = normalizeMetadata({
    raw: {},
    history,
    fallbackNow
  });
  const updatedAt = safeDate(legacy.updatedAt) ?? metadata.lastActivityAt;
  return toLoadedSessionRecord({
    sessionId: params.requestedSessionId,
    activeProviderId: typeof legacy.activeProviderId === "string" ? legacy.activeProviderId : undefined,
    pendingProviderId: typeof legacy.pendingProviderId === "string" ? legacy.pendingProviderId : undefined,
    history,
    metadata,
    revision: 0,
    updatedAt
  });
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
    origin: record.metadata.origin
  };
}

function parseIndexFile(raw: unknown): SessionIndexEntry[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const record = raw as { version?: unknown; sessions?: unknown };
  if (record.version !== 1 || !Array.isArray(record.sessions)) {
    return [];
  }
  const parsed: SessionIndexEntry[] = [];
  for (const item of record.sessions) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.sessionId !== "string" || entry.sessionId.trim().length === 0) {
      continue;
    }
    const createdAt = safeDate(entry.createdAt) ?? nowIso();
    const lastActivityAt = safeDate(entry.lastActivityAt) ?? createdAt;
    const updatedAt = safeDate(entry.updatedAt) ?? lastActivityAt;
    const normalized: SessionIndexEntry = {
      sessionId: entry.sessionId.trim(),
      activeProviderId: typeof entry.activeProviderId === "string" ? entry.activeProviderId : undefined,
      pendingProviderId: typeof entry.pendingProviderId === "string" ? entry.pendingProviderId : undefined,
      historyCount:
        typeof entry.historyCount === "number" && Number.isFinite(entry.historyCount) && entry.historyCount >= 0
          ? Math.floor(entry.historyCount)
          : 0,
      revision:
        typeof entry.revision === "number" && Number.isFinite(entry.revision) && entry.revision >= 0
          ? Math.floor(entry.revision)
          : 0,
      updatedAt,
      createdAt,
      lastActivityAt
    };
    if (typeof entry.title === "string" && entry.title.trim().length > 0) {
      normalized.title = entry.title.trim();
    }
    const origin = normalizeOrigin(entry.origin);
    if (origin) {
      normalized.origin = origin;
    }
    parsed.push(normalized);
  }
  return parsed;
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

function writeJsonAtomic(filePath: string, payload: unknown): void {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
  }
}

function readIndexUnlocked(sessionDirectory: string): SessionIndexEntry[] {
  const filePath = sessionIndexPath(sessionDirectory);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseIndexFile(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeIndexUnlocked(sessionDirectory: string, entries: SessionIndexEntry[]): void {
  const deduped = new Map<string, SessionIndexEntry>();
  for (const entry of entries) {
    deduped.set(entry.sessionId, entry);
  }
  const normalized = Array.from(deduped.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const payload: SessionIndexFile = {
    version: 1,
    updatedAt: nowIso(),
    sessions: normalized
  };
  writeJsonAtomic(sessionIndexPath(sessionDirectory), payload);
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

function quarantineSessionFile(params: {
  sessionDirectory: string;
  sessionId: string;
  sourceFilePath: string;
  reason: string;
}): string | undefined {
  try {
    const corruptDir = sessionCorruptDirectoryPath(params.sessionDirectory);
    ensureDirectory(corruptDir);
    const target = path.join(
      corruptDir,
      `${sanitizeSessionId(params.sessionId)}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    fs.renameSync(params.sourceFilePath, target);
    return target;
  } catch {
    return undefined;
  }
}

export function loadSessionRecordWithDiagnostics(
  sessionDirectory: string,
  sessionId: string
): SessionLoadResult {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const filePath = sessionFilePath(sessionDirectory, normalizedSessionId);

  try {
    const rawText = fs.readFileSync(filePath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      const quarantinedPath = quarantineSessionFile({
        sessionDirectory,
        sessionId: normalizedSessionId,
        sourceFilePath: filePath,
        reason: "corrupt_json"
      });
      mutateIndex(sessionDirectory, undefined, (entries) =>
        entries.filter((entry) => entry.sessionId !== normalizedSessionId)
      );
      return {
        record: null,
        diagnostics: [
          {
            code: "corrupt_json",
            message: error instanceof Error ? error.message : String(error),
            quarantinedPath
          }
        ]
      };
    }

    const parsed = parseSessionRecord({
      raw,
      requestedSessionId: normalizedSessionId
    });
    if (!parsed) {
      const quarantinedPath = quarantineSessionFile({
        sessionDirectory,
        sessionId: normalizedSessionId,
        sourceFilePath: filePath,
        reason: "invalid_shape"
      });
      mutateIndex(sessionDirectory, undefined, (entries) =>
        entries.filter((entry) => entry.sessionId !== normalizedSessionId)
      );
      return {
        record: null,
        diagnostics: [
          {
            code: "invalid_shape",
            message: "Session file has invalid structure",
            quarantinedPath
          }
        ]
      };
    }

    mutateIndex(sessionDirectory, undefined, (entries) => {
      const next = entries.filter((entry) => entry.sessionId !== parsed.sessionId);
      next.push(toIndexEntry(parsed));
      return next;
    });

    return {
      record: parsed
    };
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
  const filePath = sessionFilePath(params.sessionDirectory, normalizedSessionId);
  const lockPath = sessionLockPath(params.sessionDirectory, normalizedSessionId);

  return withLock(lockPath, params.lock, () => {
    let previous: LoadedSessionRecord | undefined;
    if (fs.existsSync(filePath)) {
      try {
        const parsed = parseSessionRecord({
          raw: JSON.parse(fs.readFileSync(filePath, "utf8")),
          requestedSessionId: normalizedSessionId
        });
        previous = parsed ?? undefined;
      } catch {
        quarantineSessionFile({
          sessionDirectory: params.sessionDirectory,
          sessionId: normalizedSessionId,
          sourceFilePath: filePath,
          reason: "corrupt_json"
        });
      }
    }

    const fallbackNow = nowIso();
    const metadata = normalizeMetadata({
      raw: {},
      history: params.history,
      fallbackNow,
      previous: previous?.metadata,
      override: params.metadata
    });
    const updatedAt = metadata.lastActivityAt || fallbackNow;
    const revision = (previous?.revision ?? 0) + 1;

    const payload: SessionRecordV2 = {
      version: 2,
      sessionId: normalizedSessionId,
      activeProviderId: params.activeProviderId,
      pendingProviderId: params.pendingProviderId,
      history: params.history,
      metadata,
      revision,
      updatedAt
    };
    writeJsonAtomic(filePath, payload);

    const saved = toLoadedSessionRecord({
      sessionId: payload.sessionId,
      activeProviderId: payload.activeProviderId,
      pendingProviderId: payload.pendingProviderId,
      history: payload.history,
      metadata: payload.metadata,
      revision: payload.revision,
      updatedAt: payload.updatedAt
    });

    mutateIndex(params.sessionDirectory, params.lock, (entries) => {
      const next = entries.filter((entry) => entry.sessionId !== saved.sessionId);
      next.push(toIndexEntry(saved));
      return next;
    });

    return saved;
  });
}

export function deleteSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  lock?: SessionStoreLockOptions;
}): boolean {
  const normalizedSessionId = normalizeSessionId(params.sessionId);
  const filePath = sessionFilePath(params.sessionDirectory, normalizedSessionId);
  const lockPath = sessionLockPath(params.sessionDirectory, normalizedSessionId);

  const removed = withLock(lockPath, params.lock, () => {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.rmSync(filePath, { force: true });
    return true;
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

  const fromFilePath = sessionFilePath(params.sessionDirectory, fromSessionId);
  const toFilePath = sessionFilePath(params.sessionDirectory, toSessionId);
  const lockPaths = [
    sessionLockPath(params.sessionDirectory, fromSessionId),
    sessionLockPath(params.sessionDirectory, toSessionId)
  ].sort((left, right) => left.localeCompare(right));

  const runRename = (): LoadedSessionRecord => {
    if (!fs.existsSync(fromFilePath)) {
      throw new SessionStoreError("not_found", `Unknown session: ${fromSessionId}`);
    }
    if (!params.overwrite && fs.existsSync(toFilePath)) {
      throw new SessionStoreError("already_exists", `Session already exists: ${toSessionId}`);
    }

    const source = loadSessionRecord(params.sessionDirectory, fromSessionId);
    if (!source) {
      throw new SessionStoreError("not_found", `Unknown session: ${fromSessionId}`);
    }

    if (params.overwrite && fs.existsSync(toFilePath)) {
      fs.rmSync(toFilePath, { force: true });
    }

    const renamed: LoadedSessionRecord = {
      ...source,
      sessionId: toSessionId,
      revision: source.revision + 1,
      updatedAt: nowIso()
    };

    const payload: SessionRecordV2 = {
      version: 2,
      sessionId: renamed.sessionId,
      activeProviderId: renamed.activeProviderId,
      pendingProviderId: renamed.pendingProviderId,
      history: renamed.history,
      metadata: renamed.metadata,
      revision: renamed.revision,
      updatedAt: renamed.updatedAt
    };
    writeJsonAtomic(toFilePath, payload);
    fs.rmSync(fromFilePath, { force: true });

    mutateIndex(params.sessionDirectory, params.lock, (entries) => {
      const next = entries.filter((entry) => entry.sessionId !== fromSessionId && entry.sessionId !== toSessionId);
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
  const filePath = sessionFilePath(params.sessionDirectory, normalizedSessionId);
  if (!params.overwrite && fs.existsSync(filePath)) {
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
  const filePath = sessionFilePath(params.sessionDirectory, sessionId);
  const lockPath = sessionLockPath(params.sessionDirectory, sessionId);

  return withLock(lockPath, params.lock, () => {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const archiveDir = sessionArchiveDirectoryPath(params.sessionDirectory);
    ensureDirectory(archiveDir);
    const archivedPath = path.join(
      archiveDir,
      `${sanitizeSessionId(sessionId)}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    fs.renameSync(filePath, archivedPath);
    mutateIndex(params.sessionDirectory, params.lock, (entries) =>
      entries.filter((entry) => entry.sessionId !== sessionId)
    );
    return { archivedPath };
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
    .filter((entry) => entry.endsWith(".json"))
    .filter((entry) => entry !== SESSION_INDEX_FILE)
    .map((entry) => {
      const encoded = entry.replace(/\.json$/i, "");
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}
