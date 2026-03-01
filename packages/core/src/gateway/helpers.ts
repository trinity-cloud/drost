import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { GatewayRestartIntent } from "../config.js";

const CONTROL_JSON_BODY_MAX_BYTES = 512_000;
const OBS_MAX_TEXT_CHARS = 8_000;
const OBS_REDACTED_TEXT = "[REDACTED]";
const OBS_MAX_REDACTION_DEPTH = 10;
const OBS_SENSITIVE_KEY_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "client_secret",
  "private_key",
  "access_token",
  "refresh_token",
  "session_token",
  "id_token",
  "token"
]);

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function pad3(value: number): string {
  return value.toString().padStart(3, "0");
}

function clipText(value: string, maxChars = OBS_MAX_TEXT_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  const dropped = value.length - maxChars;
  return `${value.slice(0, maxChars)}...[truncated ${dropped} chars]`;
}

function isSensitiveObservabilityKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (OBS_SENSITIVE_KEY_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key")
  );
}

function redactStringSecrets(value: string): string {
  let sanitized = value;
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, `Bearer ${OBS_REDACTED_TEXT}`);
  sanitized = sanitized.replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, OBS_REDACTED_TEXT);
  sanitized = sanitized.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi, OBS_REDACTED_TEXT);
  sanitized = sanitized.replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, OBS_REDACTED_TEXT);
  sanitized = sanitized.replace(
    /\b(token|secret|password|passphrase|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
    (_, label: string) => `${label}=${OBS_REDACTED_TEXT}`
  );
  return sanitized;
}

function sanitizeObservabilityValue(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactStringSecrets(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= OBS_MAX_REDACTION_DEPTH) {
    return "[Truncated depth]";
  }

  if (Buffer.isBuffer(value)) {
    return redactStringSecrets(value.toString("utf8"));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeObservabilityValue(entry, depth + 1, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactStringSecrets(value.message),
      stack: value.stack ? redactStringSecrets(value.stack) : undefined
    };
  }

  if (typeof value === "object") {
    const references = seen ?? new WeakSet<object>();
    const record = value as Record<string, unknown>;
    if (references.has(record)) {
      return "[Circular]";
    }
    references.add(record);
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (isSensitiveObservabilityKey(key)) {
        sanitized[key] = OBS_REDACTED_TEXT;
      } else {
        sanitized[key] = sanitizeObservabilityValue(entry, depth + 1, references);
      }
    }
    return sanitized;
  }

  return redactStringSecrets(String(value));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function sessionStorageBytes(sessionDirectory: string, sessionId: string): number {
  const encoded = encodeURIComponent(sessionId);
  const files = [`${encoded}.jsonl`, `${encoded}.full.jsonl`];
  let total = 0;
  for (const fileName of files) {
    const filePath = path.join(sessionDirectory, fileName);
    try {
      total += fs.statSync(filePath).size;
    } catch {
      // ignore missing files
    }
  }
  return total;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

export function restartIntent(value: string | GatewayRestartIntent | undefined): GatewayRestartIntent {
  if (value === "self_mod" || value === "config_change" || value === "signal") {
    return value;
  }
  return "manual";
}

export function createEvolutionTransactionId(): string {
  return `evo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sessionTimestampToken(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  const seconds = pad2(date.getUTCSeconds());
  const millis = pad3(date.getUTCMilliseconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}`;
}

export function normalizeSessionChannelPart(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "session";
  }
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "session";
}

export function readControlRequestBody(
  request: http.IncomingMessage,
  maxBytes = CONTROL_JSON_BODY_MAX_BYTES
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk) => {
      if (!chunk) {
        return;
      }
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += normalized.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(normalized);
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function parseBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function summarizeForObservability(value: unknown): unknown {
  const sanitized = sanitizeObservabilityValue(value);
  if (typeof sanitized === "string") {
    return clipText(sanitized);
  }
  if (sanitized === null || sanitized === undefined) {
    return sanitized;
  }
  try {
    return JSON.parse(clipText(JSON.stringify(sanitized)));
  } catch {
    return clipText(String(sanitized));
  }
}
