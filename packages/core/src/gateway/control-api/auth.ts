import http from "node:http";
import type { GatewayRuntimeEvent } from "../../gateway.js";
import { isLoopbackRemoteAddress, parseBearerToken } from "../helpers.js";

const CONTROL_EVENT_STREAM_PING_MS = 15_000;

type ControlAuthScope = "none" | "read" | "admin";

export interface ControlAuthResult {
  ok: boolean;
  statusCode?: number;
  message?: string;
  scope: ControlAuthScope;
  mutationKey?: string;
}

export function controlAuthResult(
  runtime: any,
  request: http.IncomingMessage,
  isMutation: boolean
): ControlAuthResult {
  const allowLoopbackWithoutAuth = runtime.config.controlApi?.allowLoopbackWithoutAuth ?? false;
  const remoteAddress = request.socket.remoteAddress;
  if (allowLoopbackWithoutAuth && isLoopbackRemoteAddress(remoteAddress)) {
    return {
      ok: true,
      scope: "admin",
      mutationKey: `loopback:${remoteAddress ?? "unknown"}`
    };
  }

  const adminToken = runtime.config.controlApi?.token?.trim();
  const readToken = runtime.config.controlApi?.readToken?.trim();
  const bearer = parseBearerToken(
    typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : undefined
  );
  if (!bearer) {
    return {
      ok: false,
      statusCode: 401,
      message: "Missing bearer token",
      scope: "none"
    };
  }

  let scope: ControlAuthScope = "none";
  if (adminToken && bearer === adminToken) {
    scope = "admin";
  } else if (readToken && bearer === readToken) {
    scope = "read";
  }

  if (scope === "none") {
    return {
      ok: false,
      statusCode: 401,
      message: "Invalid bearer token",
      scope: "none"
    };
  }
  if (isMutation && scope !== "admin") {
    return {
      ok: false,
      statusCode: 403,
      message: "Mutation scope requires admin token",
      scope
    };
  }

  return {
    ok: true,
    scope,
    mutationKey: `${scope}:${remoteAddress ?? "unknown"}:${bearer.slice(0, 12)}`
  };
}

export function consumeControlMutationBudget(runtime: any, key: string): boolean {
  const limit = runtime.config.controlApi?.mutationRateLimitPerMinute ?? 60;
  if (limit <= 0) {
    return true;
  }

  const now = Date.now();
  const earliest = now - 60_000;
  const bucket = (runtime.controlMutationBuckets.get(key) ?? []).filter((timestamp: number) => timestamp >= earliest);
  if (bucket.length >= limit) {
    runtime.controlMutationBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  runtime.controlMutationBuckets.set(key, bucket);
  return true;
}

export function startControlEventStream(
  runtime: any,
  request: http.IncomingMessage,
  response: http.ServerResponse
): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();

  const snapshot = {
    status: runtime.getStatus(),
    events: runtime.listRuntimeEvents(100)
  };
  response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  runtime.controlEventStreams.add(response);

  const ping = setInterval(() => {
    if (!runtime.controlEventStreams.has(response)) {
      clearInterval(ping);
      return;
    }
    try {
      response.write(": keepalive\n\n");
    } catch {
      runtime.controlEventStreams.delete(response);
      clearInterval(ping);
    }
  }, CONTROL_EVENT_STREAM_PING_MS);

  const onClose = () => {
    clearInterval(ping);
    runtime.controlEventStreams.delete(response);
  };
  request.on("close", onClose);
  response.on("close", onClose);
  response.on("error", onClose);
}

export function broadcastControlRuntimeEvent(runtime: any, event: GatewayRuntimeEvent): void {
  if (runtime.controlEventStreams.size === 0) {
    return;
  }

  const sequence = ++runtime.controlEventSequence;
  const frame = `id: ${sequence}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of Array.from(runtime.controlEventStreams)) {
    try {
      (stream as http.ServerResponse).write(frame);
    } catch {
      runtime.controlEventStreams.delete(stream);
    }
  }
}
