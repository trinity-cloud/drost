import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ensureDirectory, nowIso, summarizeForObservability } from "./helpers.js";

interface PersistedChannelLaneState {
  sessionId: string;
  mode: "queue" | "interrupt" | "collect" | "steer" | "steer_backlog";
  cap: number;
  dropPolicy: "old" | "new" | "summarize";
  collectDebounceMs: number;
  queuedInputs: string[];
  activeInput?: string;
}

interface PersistedChannelLaneSnapshot {
  version: 1;
  updatedAt: string;
  lanes: PersistedChannelLaneState[];
}

export function shouldPersistOrchestrationState(runtime: any): boolean {
  return (runtime.config.orchestration?.enabled ?? false) && (runtime.config.orchestration?.persistState ?? false);
}

export function persistedLaneStateSnapshot(runtime: any): PersistedChannelLaneSnapshot {
  const lanes: PersistedChannelLaneState[] = [];
  for (const [sessionId, lane] of runtime.channelLanes.entries()) {
    lanes.push({
      sessionId,
      mode: lane.mode,
      cap: lane.cap,
      dropPolicy: lane.dropPolicy,
      collectDebounceMs: lane.collectDebounceMs,
      queuedInputs: lane.queue.map((entry: { input: string }) => entry.input),
      activeInput: lane.active?.input
    });
  }
  return {
    version: 1,
    updatedAt: nowIso(),
    lanes
  };
}

export function writeOrchestrationState(runtime: any, snapshot: PersistedChannelLaneSnapshot): void {
  ensureDirectory(path.dirname(runtime.orchestrationStatePath));
  const next = JSON.stringify(snapshot, null, 2);
  const tempPath = `${runtime.orchestrationStatePath}.tmp`;
  fs.writeFileSync(tempPath, next, "utf8");
  fs.renameSync(tempPath, runtime.orchestrationStatePath);
}

export function persistOrchestrationState(runtime: any): void {
  if (!shouldPersistOrchestrationState(runtime) || runtime.suppressOrchestrationPersistence) {
    return;
  }
  try {
    writeOrchestrationState(runtime, persistedLaneStateSnapshot(runtime));
  } catch (error) {
    runtime.degradedReasons.push(
      `Failed to persist orchestration lane state: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export function restoreOrchestrationState(runtime: any): void {
  if (!shouldPersistOrchestrationState(runtime)) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(runtime.orchestrationStatePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    runtime.degradedReasons.push(
      `Failed to read orchestration lane state: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChannelLaneSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.lanes)) {
      return;
    }
    for (const laneRecord of parsed.lanes) {
      const sessionId = typeof laneRecord?.sessionId === "string" ? laneRecord.sessionId.trim() : "";
      if (!sessionId) {
        continue;
      }
      const lane = {
        mode:
          laneRecord.mode === "interrupt" ||
          laneRecord.mode === "collect" ||
          laneRecord.mode === "steer" ||
          laneRecord.mode === "steer_backlog"
            ? laneRecord.mode
            : "queue",
        cap:
          typeof laneRecord.cap === "number" && Number.isFinite(laneRecord.cap)
            ? Math.max(1, Math.floor(laneRecord.cap))
            : Math.max(1, runtime.config.orchestration?.defaultCap ?? 32),
        dropPolicy:
          laneRecord.dropPolicy === "new" || laneRecord.dropPolicy === "summarize"
            ? laneRecord.dropPolicy
            : "old",
        collectDebounceMs:
          typeof laneRecord.collectDebounceMs === "number" && Number.isFinite(laneRecord.collectDebounceMs)
            ? Math.max(0, Math.floor(laneRecord.collectDebounceMs))
            : Math.max(0, runtime.config.orchestration?.collectDebounceMs ?? 350),
        queue: [] as Array<{
          input: string;
          onEvent: () => undefined;
          resolve: () => undefined;
          reject: () => undefined;
          enqueuedAt: string;
        }>,
        active: null as null,
        collectTimer: null
      };

      const restoredInputs: string[] = [];
      if (typeof laneRecord.activeInput === "string" && laneRecord.activeInput.trim().length > 0) {
        restoredInputs.push(laneRecord.activeInput);
      }
      if (Array.isArray(laneRecord.queuedInputs)) {
        for (const input of laneRecord.queuedInputs) {
          if (typeof input === "string" && input.trim().length > 0) {
            restoredInputs.push(input);
          }
        }
      }
      for (const input of restoredInputs) {
        lane.queue.push({
          input,
          onEvent: () => undefined,
          resolve: () => undefined,
          reject: () => undefined,
          enqueuedAt: nowIso()
        });
      }
      runtime.channelLanes.set(sessionId, lane);
    }
  } catch (error) {
    runtime.degradedReasons.push(
      `Failed to parse orchestration lane state: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export async function startHealthServer(runtime: any): Promise<void> {
  if (runtime.healthServer) {
    return;
  }

  const enabled = runtime.config.health?.enabled ?? false;
  if (!enabled) {
    runtime.healthUrl = undefined;
    return;
  }

  const host = runtime.config.health?.host?.trim() || "127.0.0.1";
  const port = runtime.config.health?.port ?? 8787;
  const endpointPath = runtime.config.health?.path?.trim() || "/healthz";

  const server = http.createServer((request, response) => {
    const requestPath = (request.url ?? "").split("?")[0] ?? "";
    if (requestPath !== endpointPath) {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const status = runtime.getStatus();
    const startedAtMs = status.startedAt ? Date.parse(status.startedAt) : NaN;
    const uptimeSec =
      Number.isFinite(startedAtMs) && startedAtMs > 0
        ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
        : 0;

    response.statusCode = status.state === "degraded" ? 503 : 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        ok: status.state === "running",
        state: status.state,
        startedAt: status.startedAt,
        uptimeSec,
        degradedReasons: status.degradedReasons,
        healthUrl: runtime.healthUrl
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address && typeof address === "object") {
    runtime.healthUrl = `http://${host}:${address.port}${endpointPath}`;
  } else {
    runtime.healthUrl = `http://${host}:${port}${endpointPath}`;
  }
  runtime.healthServer = server;
}

export async function stopHealthServer(runtime: any): Promise<void> {
  const server = runtime.healthServer;
  runtime.healthServer = null;
  runtime.healthUrl = undefined;
  if (!server) {
    return;
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export function ensureObservabilityDirectory(runtime: any): void {
  if (!(runtime.config.observability?.enabled ?? false)) {
    return;
  }
  ensureDirectory(runtime.observabilityDirectory);
}

export function appendObservabilityRecord(
  runtime: any,
  stream: "runtime-events" | "tool-traces" | "usage-events",
  payload: unknown,
  featureEnabled?: boolean
): void {
  if (!(runtime.config.observability?.enabled ?? false)) {
    return;
  }
  if (featureEnabled === false) {
    return;
  }
  try {
    ensureObservabilityDirectory(runtime);
    const entry = {
      timestamp: nowIso(),
      stream,
      payload: summarizeForObservability(payload)
    };
    fs.appendFileSync(
      path.join(runtime.observabilityDirectory, `${stream}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  } catch (error) {
    if (runtime.observabilityWriteFailed) {
      return;
    }
    runtime.observabilityWriteFailed = true;
    runtime.degradedReasons.push(
      `Observability write failed: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export function writeControlJson(
  _runtime: any,
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
