import type { ProviderNativeToolCall } from "./types.js";

const TOOL_NATIVE_CALLS_MARKER = "TOOL_NATIVE_CALLS";
const TOOL_RESULT_MARKER = "TOOL_RESULT";

function unwrapFencedJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 3) {
    return trimmed;
  }
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!first.startsWith("```") || !last.startsWith("```")) {
    return trimmed;
  }
  return lines.slice(1, -1).join("\n").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function parseMarkerJson(marker: string, text: string): unknown | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const afterMarker = text.slice(markerIndex + marker.length).trim();
  if (!afterMarker) {
    return null;
  }
  const unwrapped = unwrapFencedJson(afterMarker);
  const jsonPart = extractFirstJsonObject(unwrapped) ?? extractFirstJsonObject(afterMarker);
  if (!jsonPart) {
    return null;
  }
  try {
    return JSON.parse(jsonPart);
  } catch {
    return null;
  }
}

function toNativeToolCall(value: unknown): ProviderNativeToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return null;
  }
  const idCandidate = typeof record.id === "string" ? record.id.trim() : "";
  return {
    id: idCandidate.length > 0 ? idCandidate : undefined,
    name,
    input: record.input ?? {}
  };
}

function dedupeKey(call: ProviderNativeToolCall): string {
  const id = call.id?.trim();
  if (id) {
    return `id:${id}`;
  }
  try {
    return `shape:${call.name}:${JSON.stringify(call.input ?? {})}`;
  } catch {
    return `shape:${call.name}:unserializable`;
  }
}

export function normalizeNativeToolCalls(value: unknown): ProviderNativeToolCall[] {
  const source = Array.isArray(value) ? value : [];
  const normalized: ProviderNativeToolCall[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const call = toNativeToolCall(item);
    if (!call) {
      continue;
    }
    const key = dedupeKey(call);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(call);
  }
  return normalized;
}

export function encodeNativeToolCallsMessage(calls: ProviderNativeToolCall[]): string {
  return `${TOOL_NATIVE_CALLS_MARKER} ${JSON.stringify({ calls })}`;
}

export function parseNativeToolCallsMessage(text: string): ProviderNativeToolCall[] | null {
  if (!text.includes(TOOL_NATIVE_CALLS_MARKER)) {
    return null;
  }
  const parsed = parseMarkerJson(TOOL_NATIVE_CALLS_MARKER, text);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const calls = normalizeNativeToolCalls((parsed as Record<string, unknown>).calls);
  return calls.length > 0 ? calls : null;
}

export interface ParsedToolResultPayload {
  name?: string;
  callId?: string;
  ok?: boolean;
  output?: unknown;
  error?: unknown;
}

export function encodeToolResultMessage(payload: {
  name: string;
  callId?: string | null;
  ok: boolean;
  output?: unknown;
  error?: unknown;
}): string {
  const body: Record<string, unknown> = {
    name: payload.name,
    ok: payload.ok
  };
  if (payload.callId && payload.callId.trim().length > 0) {
    body.callId = payload.callId.trim();
  }
  if ("output" in payload) {
    body.output = payload.output;
  }
  if ("error" in payload) {
    body.error = payload.error;
  }
  return `${TOOL_RESULT_MARKER} ${JSON.stringify(body)}`;
}

export function parseToolResultMessage(text: string): ParsedToolResultPayload | null {
  if (!text.includes(TOOL_RESULT_MARKER)) {
    return null;
  }
  const parsed = parseMarkerJson(TOOL_RESULT_MARKER, text);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  const callIdCandidate = typeof record.callId === "string" ? record.callId.trim() : "";
  return {
    name: name && name.length > 0 ? name : undefined,
    callId: callIdCandidate.length > 0 ? callIdCandidate : undefined,
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
    output: record.output,
    error: record.error
  };
}
