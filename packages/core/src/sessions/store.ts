import fs from "node:fs";
import type { ChatMessage } from "../types.js";
import { parseSessionEventLine, serializeMessageLines, toSessionMessageLines } from "./codec.js";
import { mutateIndex, readIndexUnlocked, resolveIndexEntry } from "./index-store.js";
import { appendText, withLock, writeTextAtomic } from "./locking.js";
import { isHistoryPrefix, quarantineFile, readSerializedEventLines, readSessionMessagesFromJsonl } from "./jsonl-store.js";
import { sessionFullPath, sessionLockPath, sessionTranscriptPath } from "./paths.js";
import type {
  LoadedSessionRecord,
  SessionEventLine,
  SessionIndexEntry,
  SessionLoadResult,
  SessionMetadata,
  SessionStoreLockOptions
} from "./types.js";
import {
  ensureDirectory,
  normalizeMetadata,
  normalizeSessionId,
  nowIso,
  safeDate,
  toIndexEntry,
  toLoadedSessionRecord
} from "./utils.js";

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

export function loadSessionRecordUnlocked(
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
  ensureDirectory(params.sessionDirectory);

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
    .filter((entry) => entry.endsWith(".full.jsonl"))
    .map((entry) => {
      const encoded = entry.slice(0, -".full.jsonl".length);
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}
