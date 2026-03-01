import { archiveSessionRecord, deleteSessionRecord, listSessionIndex } from "../../sessions.js";
import type { SessionStoreConfig } from "../../config.js";
import { sessionStorageBytes } from "../helpers.js";

export function applySessionRetentionPlan(
  runtime: any,
  dryRun: boolean,
  policyOverride?: SessionStoreConfig["retention"]
): { archived: string[]; deleted: string[] } {
  if (!runtime.sessionStoreEnabled) {
    return {
      archived: [],
      deleted: []
    };
  }

  const policy = policyOverride ?? runtime.config.sessionStore?.retention;
  if (!policy || policy.enabled === false) {
    return {
      archived: [],
      deleted: []
    };
  }

  const now = Date.now();
  const manager = runtime.ensureProviderManager();
  const archiveFirst = policy.archiveFirst ?? true;
  const protectedSessions = new Set<string>();
  for (const session of manager?.listSessions() ?? []) {
    if (session.turnInProgress) {
      protectedSessions.add(session.sessionId);
    }
  }

  const entries = listSessionIndex(runtime.sessionDirectory);
  const removed = new Set<string>();
  const archived: string[] = [];
  const deleted: string[] = [];

  const removeSession = (sessionId: string): void => {
    if (!sessionId || removed.has(sessionId) || protectedSessions.has(sessionId)) {
      return;
    }

    if (archiveFirst) {
      if (dryRun) {
        archived.push(sessionId);
        removed.add(sessionId);
        return;
      }
      const archivedResult = archiveSessionRecord({
        sessionDirectory: runtime.sessionDirectory,
        sessionId,
        lock: runtime.sessionLockOptions()
      });
      if (archivedResult) {
        archived.push(sessionId);
        removed.add(sessionId);
        try {
          manager?.deleteSession(sessionId);
        } catch {
          // best effort
        }
        return;
      }
    }

    if (dryRun) {
      deleted.push(sessionId);
      removed.add(sessionId);
      return;
    }
    const deletedResult = deleteSessionRecord({
      sessionDirectory: runtime.sessionDirectory,
      sessionId,
      lock: runtime.sessionLockOptions()
    });
    if (deletedResult) {
      deleted.push(sessionId);
      removed.add(sessionId);
      try {
        manager?.deleteSession(sessionId);
      } catch {
        // best effort
      }
    }
  };

  const maxAgeDays = policy.maxAgeDays ?? 0;
  if (maxAgeDays > 0) {
    const ageCutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const lastActivityMs = Date.parse(entry.lastActivityAt);
      if (!Number.isFinite(lastActivityMs)) {
        continue;
      }
      if (lastActivityMs <= ageCutoffMs) {
        removeSession(entry.sessionId);
      }
    }
  }

  const archiveAfterIdleMs = policy.archiveAfterIdleMs ?? 0;
  if (archiveAfterIdleMs > 0) {
    for (const entry of entries) {
      if (removed.has(entry.sessionId)) {
        continue;
      }
      const lastActivityMs = Date.parse(entry.lastActivityAt);
      if (!Number.isFinite(lastActivityMs)) {
        continue;
      }
      if (now - lastActivityMs >= archiveAfterIdleMs) {
        removeSession(entry.sessionId);
      }
    }
  }

  const remaining = entries
    .filter((entry) => !removed.has(entry.sessionId))
    .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));

  const maxSessions = policy.maxSessions ?? 0;
  if (maxSessions > 0 && remaining.length > maxSessions) {
    for (const entry of remaining.slice(maxSessions)) {
      removeSession(entry.sessionId);
    }
  }

  const maxTotalBytes = policy.maxTotalBytes ?? 0;
  if (maxTotalBytes > 0) {
    const latestEntries = listSessionIndex(runtime.sessionDirectory)
      .filter((entry) => !removed.has(entry.sessionId))
      .sort((left, right) => Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt));
    let totalBytes = latestEntries.reduce(
      (sum, entry) => sum + sessionStorageBytes(runtime.sessionDirectory, entry.sessionId),
      0
    );
    for (const entry of latestEntries) {
      if (totalBytes <= maxTotalBytes) {
        break;
      }
      const bytes = sessionStorageBytes(runtime.sessionDirectory, entry.sessionId);
      removeSession(entry.sessionId);
      totalBytes = Math.max(0, totalBytes - bytes);
    }
  }

  return {
    archived,
    deleted
  };
}

export function enforceSessionRetention(runtime: any): { archived: string[]; deleted: string[] } {
  return applySessionRetentionPlan(runtime, false);
}

export function pruneSessions(
  runtime: any,
  params?: {
    dryRun?: boolean;
    policyOverride?: SessionStoreConfig["retention"];
  }
): { archived: string[]; deleted: string[]; dryRun: boolean } {
  const dryRun = params?.dryRun === true;
  const result = applySessionRetentionPlan(runtime, dryRun, params?.policyOverride);
  return {
    ...result,
    dryRun
  };
}

export function getSessionRetentionStatus(runtime: any): {
  enabled: boolean;
  policy?: SessionStoreConfig["retention"];
  totalSessions: number;
  totalBytes: number;
} {
  const enabled = (runtime.config.sessionStore?.retention?.enabled ?? true) && runtime.sessionStoreEnabled;
  if (!runtime.sessionStoreEnabled) {
    return {
      enabled: false,
      policy: runtime.config.sessionStore?.retention,
      totalSessions: 0,
      totalBytes: 0
    };
  }
  const index = listSessionIndex(runtime.sessionDirectory);
  const totalBytes = index.reduce(
    (sum, entry) => sum + sessionStorageBytes(runtime.sessionDirectory, entry.sessionId),
    0
  );
  return {
    enabled,
    policy: runtime.config.sessionStore?.retention,
    totalSessions: index.length,
    totalBytes
  };
}
