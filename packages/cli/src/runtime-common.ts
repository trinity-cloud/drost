import fs from "node:fs";
import path from "node:path";
import type { GatewayRuntime } from "@drost/core";

export interface SessionSummary {
  sessionId: string;
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  historyCount: number;
  active: boolean;
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function parseToolCommand(raw: string): { toolName: string; input: unknown } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "tool name required" };
  }

  const firstSpace = trimmed.indexOf(" ");
  const toolName = firstSpace >= 0 ? trimmed.slice(0, firstSpace).trim() : trimmed;
  const rawJson = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";
  if (!toolName) {
    return { error: "tool name required" };
  }

  if (!rawJson) {
    return {
      toolName,
      input: {}
    };
  }

  try {
    return {
      toolName,
      input: JSON.parse(rawJson)
    };
  } catch (error) {
    return {
      error: `invalid tool json: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function summarizeToolValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensurePidDir(pidFilePath: string): void {
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
}

export function writePidFile(pidFilePath: string): void {
  ensurePidDir(pidFilePath);
  fs.writeFileSync(pidFilePath, `${process.pid}\n`);
}

export function removePidFile(pidFilePath: string): void {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // best effort
  }
}

export function loadSessions(gateway: GatewayRuntime, activeSessionId: string): void {
  gateway.ensureSession(activeSessionId);
  const persistedSessionIds = gateway.listPersistedSessionIds();
  for (const sessionId of persistedSessionIds) {
    if (sessionId === activeSessionId) {
      continue;
    }
    gateway.ensureSession(sessionId);
  }
}

export function buildSessionSummaries(gateway: GatewayRuntime, activeSessionId: string): SessionSummary[] {
  return gateway
    .listSessionSnapshots()
    .map((session) => ({
      ...session,
      active: session.sessionId === activeSessionId
    }));
}
