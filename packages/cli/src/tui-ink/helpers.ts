import type { GatewayRuntime, GatewayStatus } from "@drost/core";
import { renderMarkdownToTerminal, type TuiTranscriptEntry } from "@drost/tui";
import { buildSessionSummaries, loadSessions, type SessionSummary } from "../runtime-common.js";
import { hydrateSessionHistory, type TuiConversationBuffers } from "../tui-state.js";

export type { SessionSummary };

export type ThemeMode = "dark" | "light";

export type Theme = {
  accent: string;
  muted: string;
  faint: string;
  border: string;
  warn: string;
  error: string;
  ok: string;
};

export const THEMES: Record<ThemeMode, Theme> = {
  dark: {
    accent: "#2DD4BF",
    muted: "#94A3B8",
    faint: "#64748B",
    border: "#334155",
    warn: "#F59E0B",
    error: "#EF4444",
    ok: "#22C55E"
  },
  light: {
    accent: "#0F766E",
    muted: "#475569",
    faint: "#64748B",
    border: "#CBD5E1",
    warn: "#B45309",
    error: "#B91C1C",
    ok: "#15803D"
  }
};

export function hydrateTranscriptFromSessions(gateway: GatewayRuntime, buffers: TuiConversationBuffers): void {
  const snapshots = gateway
    .listSessionSnapshots()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  for (const session of snapshots) {
    hydrateSessionHistory(buffers, {
      sessionId: session.sessionId,
      providerId: session.activeProviderId,
      history: gateway.getSessionHistory(session.sessionId)
    });
  }
}

export function bootstrapSessions(gateway: GatewayRuntime, activeSessionId: string): void {
  loadSessions(gateway, activeSessionId);
}

export function summarizeSessions(gateway: GatewayRuntime, activeSessionId: string): SessionSummary[] {
  return buildSessionSummaries(gateway, activeSessionId);
}

export function normalizeEventLine(line: string): string {
  return line.startsWith("[drost] ") ? line.slice("[drost] ".length) : line;
}

export function formatGatewayState(status: GatewayStatus): { label: string; color: "green" | "yellow" | "red" } {
  if (status.state === "degraded") {
    return { label: "degraded", color: "yellow" };
  }
  if (status.state === "running") {
    return { label: "running", color: "green" };
  }
  return { label: status.state, color: "red" };
}

export function toolCount(status: GatewayStatus): number {
  const diagnostics = status.toolDiagnostics;
  if (!diagnostics) {
    return 0;
  }
  return diagnostics.loadedBuiltInCount + diagnostics.loadedCustomCount;
}

export function probeSummary(status: GatewayStatus): { ok: number; fail: number } {
  const diagnostics = status.providerDiagnostics ?? [];
  let ok = 0;
  let fail = 0;
  for (const probe of diagnostics) {
    if (probe.ok) {
      ok += 1;
    } else {
      fail += 1;
    }
  }
  return { ok, fail };
}

function eventColor(line: string): "white" | "yellow" | "red" {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("failed")) {
    return "red";
  }
  if (lower.includes("degraded") || lower.includes("missing") || lower.includes("warn")) {
    return "yellow";
  }
  return "white";
}

export function eventThemeColor(theme: Theme, line: string): string {
  const tone = eventColor(line);
  if (tone === "red") {
    return theme.error;
  }
  if (tone === "yellow") {
    return theme.warn;
  }
  return theme.muted;
}

export function toTranscriptLines(
  entries: TuiTranscriptEntry[],
  maxEntries: number
): Array<{
  id: string;
  role: TuiTranscriptEntry["role"];
  sessionId: string;
  providerId?: string;
  text: string;
  usage?: string;
  streaming?: boolean;
}> {
  const selected = entries.slice(-maxEntries);
  return selected.map((entry) => ({
    id: entry.id,
    role: entry.role,
    sessionId: entry.sessionId,
    providerId: entry.providerId,
    text:
      entry.role === "user" || entry.role === "assistant"
        ? renderMarkdownToTerminal((entry.text || "(waiting for response)").replace(/\r/g, ""))
        : (entry.text || "(waiting for response)").replace(/\r/g, ""),
    usage: entry.usage,
    streaming: entry.streaming
  }));
}
