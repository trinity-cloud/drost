import fs from "node:fs";
import path from "node:path";
import { SESSION_FULL_SUFFIX, SESSION_TRANSCRIPT_SUFFIX } from "./constants.js";
import { mutateIndex, readIndexUnlocked, resolveIndexEntry } from "./index-store.js";
import { withLock } from "./locking.js";
import { sessionArchiveDirectoryPath, sessionFullPath, sessionLockPath, sessionTranscriptPath } from "./paths.js";
import { loadSessionRecord, loadSessionRecordUnlocked, saveSessionRecord } from "./store.js";
import type { LoadedSessionRecord, SessionStoreLockOptions } from "./types.js";
import { SessionStoreError } from "./types.js";
import { ensureDirectory, normalizeSessionId, nowIso, sanitizeSessionId, toIndexEntry } from "./utils.js";

function deriveSessionFilesFromEntry(
  sessionDirectory: string,
  sessionId: string
): { transcriptPath: string; fullPath: string } {
  return {
    transcriptPath: sessionTranscriptPath(sessionDirectory, sessionId),
    fullPath: sessionFullPath(sessionDirectory, sessionId)
  };
}

export function deleteSessionRecord(params: {
  sessionDirectory: string;
  sessionId: string;
  lock?: SessionStoreLockOptions;
}): boolean {
  ensureDirectory(params.sessionDirectory);
  const normalizedSessionId = normalizeSessionId(params.sessionId);
  const files = deriveSessionFilesFromEntry(params.sessionDirectory, normalizedSessionId);
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
  ensureDirectory(params.sessionDirectory);
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

    const sourceFiles = deriveSessionFilesFromEntry(params.sessionDirectory, fromSessionId);
    const targetFiles = deriveSessionFilesFromEntry(params.sessionDirectory, toSessionId);

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

  return withLock(lockPaths[0]!, params.lock, () => withLock(lockPaths[1]!, params.lock, () => runRename()));
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
  ensureDirectory(params.sessionDirectory);
  const sessionId = normalizeSessionId(params.sessionId);
  const lockPath = sessionLockPath(params.sessionDirectory, sessionId);

  return withLock(lockPath, params.lock, () => {
    const files = deriveSessionFilesFromEntry(params.sessionDirectory, sessionId);
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
