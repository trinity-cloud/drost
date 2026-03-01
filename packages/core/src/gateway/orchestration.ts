import type { ChannelTurnRequest, ChannelTurnResult } from "../channels.js";
import type { StreamEventHandler } from "../events.js";
import type { ChatInputImage } from "../types.js";
import { nowIso } from "./helpers.js";

interface PendingChannelTurn {
  input: string;
  inputImages?: ChatInputImage[];
  onEvent: StreamEventHandler;
  resolve: (result: ChannelTurnResult) => void;
  reject: (error: unknown) => void;
  enqueuedAt: string;
}

interface ActiveChannelTurn {
  input: string;
  inputImages?: ChatInputImage[];
  onEvent: StreamEventHandler;
  resolveMany: Array<(result: ChannelTurnResult) => void>;
  rejectMany: Array<(error: unknown) => void>;
  controller: AbortController;
}

interface ChannelLaneState {
  mode: "queue" | "interrupt" | "collect" | "steer" | "steer_backlog";
  cap: number;
  dropPolicy: "old" | "new" | "summarize";
  collectDebounceMs: number;
  queue: PendingChannelTurn[];
  active: ActiveChannelTurn | null;
  collectTimer: NodeJS.Timeout | null;
}

export function resolveOrchestrationMode(runtime: any): "queue" | "interrupt" | "collect" | "steer" | "steer_backlog" {
  const mode = runtime.config.orchestration?.defaultMode ?? "queue";
  if (mode === "interrupt" || mode === "collect" || mode === "steer" || mode === "steer_backlog") {
    return mode;
  }
  return "queue";
}

export function laneForSession(runtime: any, sessionId: string): ChannelLaneState {
  const existing = runtime.channelLanes.get(sessionId) as ChannelLaneState | undefined;
  if (existing) {
    return existing;
  }
  const created: ChannelLaneState = {
    mode: resolveOrchestrationMode(runtime),
    cap: Math.max(1, runtime.config.orchestration?.defaultCap ?? 32),
    dropPolicy: runtime.config.orchestration?.dropPolicy ?? "old",
    collectDebounceMs: Math.max(0, runtime.config.orchestration?.collectDebounceMs ?? 350),
    queue: [],
    active: null,
    collectTimer: null
  };
  runtime.channelLanes.set(sessionId, created);
  runtime.persistOrchestrationState();
  return created;
}

export async function runChannelTurnDirect(
  runtime: any,
  params: {
    sessionId: string;
    input: string;
    inputImages?: ChatInputImage[];
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }
): Promise<ChannelTurnResult> {
  await runtime.runSessionTurn({
    sessionId: params.sessionId,
    input: params.input,
    inputImages: params.inputImages,
    onEvent: params.onEvent,
    signal: params.signal
  });

  const history = runtime.getSessionHistory(params.sessionId);
  let response = "";
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === "assistant") {
      response = message.content;
      break;
    }
  }

  const state = runtime.getSessionState(params.sessionId);
  return {
    sessionId: params.sessionId,
    providerId: state?.activeProviderId,
    response
  };
}

export function queueDrop(_runtime: any, lane: ChannelLaneState): PendingChannelTurn | null {
  if (lane.queue.length < lane.cap) {
    return null;
  }
  if (lane.dropPolicy === "new") {
    return {
      input: "",
      onEvent: () => undefined,
      resolve: () => undefined,
      reject: () => undefined,
      enqueuedAt: nowIso()
    };
  }
  const dropped = lane.queue.shift() ?? null;
  return dropped;
}

export function startLaneExecution(runtime: any, sessionId: string, lane: ChannelLaneState): void {
  if (lane.active) {
    return;
  }

  const mode = lane.mode;
  const takeNext = (): ActiveChannelTurn | null => {
    if (lane.queue.length === 0) {
      return null;
    }
    if (mode === "collect") {
      const batch = [...lane.queue];
      lane.queue.length = 0;
      const input = batch.map((entry) => entry.input).join("\n\n");
      const inputImages: ChatInputImage[] = [];
      for (const entry of batch) {
        for (const image of entry.inputImages ?? []) {
          inputImages.push(image);
        }
      }
      const onEvent: StreamEventHandler = (event) => {
        for (const entry of batch) {
          entry.onEvent(event);
        }
      };
      return {
        input,
        inputImages,
        onEvent,
        resolveMany: batch.map((entry) => entry.resolve),
        rejectMany: batch.map((entry) => entry.reject),
        controller: new AbortController()
      };
    }
    const next = lane.queue.shift();
    if (!next) {
      return null;
    }
    return {
      input: next.input,
      inputImages: next.inputImages,
      onEvent: next.onEvent,
      resolveMany: [next.resolve],
      rejectMany: [next.reject],
      controller: new AbortController()
    };
  };

  const active = takeNext();
  if (!active) {
    runtime.persistOrchestrationState();
    return;
  }
  lane.active = active;
  runtime.persistOrchestrationState();
  runtime.emitRuntimeEvent("orchestration.started", {
    sessionId,
    mode: lane.mode,
    queued: lane.queue.length
  });

  void runChannelTurnDirect(runtime, {
    sessionId,
    input: active.input,
    inputImages: active.inputImages,
    onEvent: active.onEvent,
    signal: active.controller.signal
  })
    .then((result) => {
      for (const resolve of active.resolveMany) {
        resolve(result);
      }
      runtime.emitRuntimeEvent("orchestration.completed", {
        sessionId,
        mode: lane.mode,
        queued: lane.queue.length
      });
    })
    .catch((error) => {
      for (const reject of active.rejectMany) {
        reject(error);
      }
    })
    .finally(() => {
      lane.active = null;
      if (lane.collectTimer) {
        clearTimeout(lane.collectTimer);
        lane.collectTimer = null;
      }
      runtime.persistOrchestrationState();
      startLaneExecution(runtime, sessionId, lane);
    });
}

export function submitChannelTurnToLane(
  runtime: any,
  params: {
    sessionId: string;
    input: string;
    inputImages?: ChatInputImage[];
    onEvent: StreamEventHandler;
  }
): Promise<ChannelTurnResult> {
  const lane = laneForSession(runtime, params.sessionId);
  runtime.emitRuntimeEvent("orchestration.submitted", {
    sessionId: params.sessionId,
    mode: lane.mode,
    queued: lane.queue.length
  });

  return new Promise<ChannelTurnResult>((resolve, reject) => {
    const pending: PendingChannelTurn = {
      input: params.input,
      inputImages: params.inputImages,
      onEvent: params.onEvent,
      resolve,
      reject,
      enqueuedAt: nowIso()
    };

    const effectiveMode: "queue" | "interrupt" | "collect" =
      lane.mode === "steer" ? "interrupt" : lane.mode === "steer_backlog" ? "queue" : lane.mode;

    if (effectiveMode === "interrupt") {
      for (const queued of lane.queue.splice(0)) {
        queued.reject(new Error("Dropped by interrupt queue policy"));
      }
      lane.active?.controller.abort();
      lane.queue.push(pending);
      runtime.persistOrchestrationState();
      startLaneExecution(runtime, params.sessionId, lane);
      return;
    }

    const dropped = queueDrop(runtime, lane);
    if (dropped) {
      if (lane.dropPolicy === "new") {
        reject(new Error("Queue is full (dropPolicy=new)"));
        runtime.emitRuntimeEvent("orchestration.dropped", {
          sessionId: params.sessionId,
          mode: lane.mode,
          dropPolicy: lane.dropPolicy
        });
        runtime.persistOrchestrationState();
        return;
      }
      dropped.reject(new Error("Dropped by queue capacity policy"));
      runtime.emitRuntimeEvent("orchestration.dropped", {
        sessionId: params.sessionId,
        mode: lane.mode,
        dropPolicy: lane.dropPolicy
      });
    }

    lane.queue.push(pending);
    runtime.persistOrchestrationState();
    if (effectiveMode === "collect" && lane.active) {
      return;
    }
    if (effectiveMode === "collect" && lane.collectDebounceMs > 0) {
      if (lane.collectTimer) {
        clearTimeout(lane.collectTimer);
      }
      lane.collectTimer = setTimeout(() => {
        lane.collectTimer = null;
        startLaneExecution(runtime, params.sessionId, lane);
      }, lane.collectDebounceMs);
      return;
    }
    startLaneExecution(runtime, params.sessionId, lane);
  });
}

export async function runChannelTurn(runtime: any, params: ChannelTurnRequest): Promise<ChannelTurnResult> {
  const sessionId = runtime.resolveChannelSession({
    identity: params.identity,
    mapping: params.mapping,
    title: params.title
  });
  const onEvent: StreamEventHandler = params.onEvent ?? (() => undefined);
  const orchestrationEnabled = runtime.config.orchestration?.enabled ?? false;
  if (!orchestrationEnabled) {
    return await runChannelTurnDirect(runtime, {
      sessionId,
      input: params.input,
      inputImages: params.inputImages,
      onEvent,
      signal: params.signal
    });
  }

  return await submitChannelTurnToLane(runtime, {
    sessionId,
    input: params.input,
    inputImages: params.inputImages,
    onEvent
  });
}

export function listOrchestrationLaneStatuses(runtime: any): Array<{
  sessionId: string;
  mode: "queue" | "interrupt" | "collect" | "steer" | "steer_backlog";
  cap: number;
  dropPolicy: "old" | "new" | "summarize";
  collectDebounceMs: number;
  queued: number;
  active: boolean;
}> {
  const entries = Array.from(runtime.channelLanes.entries()) as Array<[string, ChannelLaneState]>;
  return entries
    .map(([sessionId, lane]) => ({
      sessionId,
      mode: lane.mode,
      cap: lane.cap,
      dropPolicy: lane.dropPolicy,
      collectDebounceMs: lane.collectDebounceMs,
      queued: lane.queue.length,
      active: Boolean(lane.active)
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}
