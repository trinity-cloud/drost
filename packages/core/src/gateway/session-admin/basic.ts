import {
  SessionStoreError,
  archiveSessionRecord,
  deleteSessionRecord,
  exportSessionRecord,
  importSessionRecord,
  listSessionIndex,
  renameSessionRecord,
  type LoadedSessionRecord
} from "../../sessions.js";
import { nowIso } from "../helpers.js";
import type { SessionMutationResult } from "../../gateway.js";

export function deleteSession(runtime: any, sessionId: string): SessionMutationResult {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return {
      ok: false,
      message: "No provider manager configured"
    };
  }

  let deletedLive = false;
  const live = manager.getSession(sessionId);
  if (live) {
    try {
      deletedLive = manager.deleteSession(sessionId);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  let deletedPersisted = false;
  if (runtime.sessionStoreEnabled) {
    deletedPersisted = deleteSessionRecord({
      sessionDirectory: runtime.sessionDirectory,
      sessionId,
      lock: runtime.sessionLockOptions()
    });
  }

  if (!deletedLive && !deletedPersisted) {
    return {
      ok: false,
      message: `Unknown session: ${sessionId}`
    };
  }

  runtime.emitRuntimeEvent("gateway.config.reloaded", {
    action: "session.delete",
    sessionId
  });
  runtime.sessionProviderRouteOverrides.delete(sessionId);
  runtime.sessionSkillInjectionOverrides.delete(sessionId);
  return {
    ok: true,
    message: `Deleted session ${sessionId}`,
    sessionId
  };
}

export function renameSession(
  runtime: any,
  params: { fromSessionId: string; toSessionId: string }
): SessionMutationResult {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return {
      ok: false,
      message: "No provider manager configured"
    };
  }

  if (manager.getSession(params.toSessionId)) {
    return {
      ok: false,
      message: `Session already exists: ${params.toSessionId}`
    };
  }
  const sourceLive = manager.getSession(params.fromSessionId);
  if (sourceLive?.turnInProgress) {
    return {
      ok: false,
      message: `Cannot rename session in progress: ${params.fromSessionId}`
    };
  }

  let renamedPersisted = false;
  if (runtime.sessionStoreEnabled) {
    try {
      renameSessionRecord({
        sessionDirectory: runtime.sessionDirectory,
        fromSessionId: params.fromSessionId,
        toSessionId: params.toSessionId,
        lock: runtime.sessionLockOptions()
      });
      renamedPersisted = true;
    } catch (error) {
      const loaded = manager.getSession(params.fromSessionId);
      if (!loaded || !(error instanceof SessionStoreError) || error.code !== "not_found") {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }

  let renamedLive = false;
  if (sourceLive) {
    try {
      manager.renameSession({
        fromSessionId: params.fromSessionId,
        toSessionId: params.toSessionId
      });
      renamedLive = true;
    } catch (error) {
      if (renamedPersisted) {
        try {
          renameSessionRecord({
            sessionDirectory: runtime.sessionDirectory,
            fromSessionId: params.toSessionId,
            toSessionId: params.fromSessionId,
            overwrite: true,
            lock: runtime.sessionLockOptions()
          });
        } catch {
          // best effort rollback
        }
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (!renamedPersisted && !renamedLive) {
    return {
      ok: false,
      message: `Unknown session: ${params.fromSessionId}`
    };
  }

  runtime.emitRuntimeEvent("gateway.config.reloaded", {
    action: "session.rename",
    fromSessionId: params.fromSessionId,
    toSessionId: params.toSessionId
  });
  const routeOverride = runtime.sessionProviderRouteOverrides.get(params.fromSessionId);
  runtime.sessionProviderRouteOverrides.delete(params.fromSessionId);
  if (routeOverride) {
    runtime.sessionProviderRouteOverrides.set(params.toSessionId, routeOverride);
  }
  const skillModeOverride = runtime.sessionSkillInjectionOverrides.get(params.fromSessionId);
  runtime.sessionSkillInjectionOverrides.delete(params.fromSessionId);
  if (skillModeOverride) {
    runtime.sessionSkillInjectionOverrides.set(params.toSessionId, skillModeOverride);
  }
  return {
    ok: true,
    message: `Renamed session ${params.fromSessionId} -> ${params.toSessionId}`,
    sessionId: params.toSessionId
  };
}

export function exportSession(runtime: any, sessionId: string): LoadedSessionRecord | null {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return null;
  }
  const live = manager.getSession(sessionId);
  if (live) {
    return {
      sessionId: live.sessionId,
      activeProviderId: live.activeProviderId,
      pendingProviderId: live.pendingProviderId,
      history: [...live.history],
      metadata: {
        ...live.metadata
      },
      revision: 0,
      updatedAt: nowIso()
    };
  }
  if (!runtime.sessionStoreEnabled) {
    return null;
  }
  return exportSessionRecord({
    sessionDirectory: runtime.sessionDirectory,
    sessionId
  });
}

export function importSession(
  runtime: any,
  params: {
    record: LoadedSessionRecord;
    overwrite?: boolean;
  }
): SessionMutationResult {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return {
      ok: false,
      message: "No provider manager configured"
    };
  }

  const existing = manager.getSession(params.record.sessionId);
  if (existing && !params.overwrite) {
    return {
      ok: false,
      message: `Session already exists: ${params.record.sessionId}`
    };
  }
  if (existing?.turnInProgress) {
    return {
      ok: false,
      message: `Cannot overwrite session in progress: ${params.record.sessionId}`
    };
  }

  try {
    const imported = runtime.sessionStoreEnabled
      ? importSessionRecord({
          sessionDirectory: runtime.sessionDirectory,
          record: params.record,
          overwrite: params.overwrite,
          lock: runtime.sessionLockOptions()
        })
      : params.record;
    const initialProviderId =
      imported.activeProviderId ?? runtime.config.providers?.defaultSessionProvider ?? params.record.activeProviderId;
    if (!initialProviderId) {
      return {
        ok: false,
        message: "Imported session must define an active provider"
      };
    }
    manager.ensureSession(imported.sessionId, initialProviderId);
    manager.hydrateSession({
      sessionId: imported.sessionId,
      history: imported.history,
      activeProviderId: imported.activeProviderId,
      pendingProviderId: imported.pendingProviderId,
      metadata: imported.metadata
    });
    if (imported.metadata.providerRouteId) {
      runtime.sessionProviderRouteOverrides.set(imported.sessionId, imported.metadata.providerRouteId);
    }
    if (
      imported.metadata.skillInjectionMode === "off" ||
      imported.metadata.skillInjectionMode === "all" ||
      imported.metadata.skillInjectionMode === "relevant"
    ) {
      runtime.sessionSkillInjectionOverrides.set(imported.sessionId, imported.metadata.skillInjectionMode);
    }
    return {
      ok: true,
      message: `Imported session ${imported.sessionId}`,
      sessionId: imported.sessionId
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function archiveStaleSessions(runtime: any, maxIdleMs?: number): string[] {
  if (!runtime.sessionStoreEnabled) {
    return [];
  }
  const idleMs = maxIdleMs ?? runtime.config.sessionStore?.retention?.archiveAfterIdleMs;
  if (!idleMs || idleMs <= 0) {
    return [];
  }
  const now = Date.now();
  const archived: string[] = [];
  const index = listSessionIndex(runtime.sessionDirectory);
  const manager = runtime.ensureProviderManager();
  for (const entry of index) {
    const lastActivity = Date.parse(entry.lastActivityAt);
    if (!Number.isFinite(lastActivity)) {
      continue;
    }
    if (now - lastActivity < idleMs) {
      continue;
    }
    const live = manager?.getSession(entry.sessionId);
    if (live?.turnInProgress) {
      continue;
    }
    const result = archiveSessionRecord({
      sessionDirectory: runtime.sessionDirectory,
      sessionId: entry.sessionId,
      lock: runtime.sessionLockOptions()
    });
    if (result) {
      archived.push(entry.sessionId);
      manager?.deleteSession(entry.sessionId);
    }
  }
  return archived;
}
