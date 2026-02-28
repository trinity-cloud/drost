import type { GatewayStatus, SessionSnapshot, ToolRunResult } from "./gateway.js";
import type { ProviderProfile } from "./providers/types.js";
import type { StreamEventHandler } from "./events.js";

/**
 * Narrow interface of gateway methods the command dispatcher needs.
 * Keeps the dispatcher decoupled from the full GatewayRuntime class.
 */
export interface ChannelCommandGateway {
  getStatus(): GatewayStatus;
  listProviderProfiles(): ProviderProfile[];
  listSessionSnapshots(): SessionSnapshot[];
  getSessionState(
    sessionId: string
  ): { activeProviderId: string; pendingProviderId?: string } | null;
  queueSessionProviderSwitch(sessionId: string, providerId: string): void;
  listLoadedToolNames(): string[];
  runTool(params: {
    sessionId: string;
    toolName: string;
    input: unknown;
    onEvent?: StreamEventHandler;
  }): Promise<ToolRunResult>;
  requestRestart(request: {
    intent: "manual";
    reason: string;
  }): Promise<{ ok: boolean; code?: string; message?: string } | void>;
  deleteSession(sessionId: string): { ok: boolean; message: string; sessionId?: string };
}

export interface ChannelCommandSessionContext {
  sessionId: string;
}

export interface ChannelCommandResult {
  handled: boolean;
  text: string;
  ok?: boolean;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isChannelCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.length >= 2 && trimmed.startsWith("/") && /^\/[a-z]/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatchChannelCommand(
  gateway: ChannelCommandGateway,
  session: ChannelCommandSessionContext,
  input: string
): Promise<ChannelCommandResult> {
  const text = input.trim();

  if (text === "/help") {
    return { handled: true, text: formatHelp(), ok: true };
  }

  if (text === "/status") {
    return { handled: true, text: formatStatus(gateway.getStatus()), ok: true };
  }

  if (text === "/providers") {
    return {
      handled: true,
      text: formatProviders(gateway.listProviderProfiles()),
      ok: true
    };
  }

  if (text === "/provider" || text.startsWith("/provider ")) {
    const providerId = text.slice("/provider".length).trim();
    if (!providerId) {
      return { handled: true, text: "Usage: /provider <id>", ok: false };
    }
    try {
      gateway.queueSessionProviderSwitch(session.sessionId, providerId);
      const state = gateway.getSessionState(session.sessionId);
      return {
        handled: true,
        text: `Provider queued for next turn: ${providerId} (active: ${state?.activeProviderId ?? "n/a"})`,
        ok: true
      };
    } catch (error) {
      return { handled: true, text: toErrorText(error), ok: false };
    }
  }

  if (text === "/session") {
    const state = gateway.getSessionState(session.sessionId);
    return {
      handled: true,
      text: formatSessionInfo(session.sessionId, state),
      ok: true
    };
  }

  if (text === "/sessions") {
    return {
      handled: true,
      text: formatSessions(gateway.listSessionSnapshots(), session.sessionId),
      ok: true
    };
  }

  if (text === "/new") {
    try {
      const result = gateway.deleteSession(session.sessionId);
      if (!result.ok) {
        return { handled: true, text: `Failed to start new session: ${result.message}`, ok: false };
      }
      return {
        handled: true,
        text: `Started new session (cleared history for ${session.sessionId}).`,
        ok: true
      };
    } catch (error) {
      return { handled: true, text: toErrorText(error), ok: false };
    }
  }

  if (text === "/tools") {
    return {
      handled: true,
      text: formatTools(gateway.listLoadedToolNames()),
      ok: true
    };
  }

  if (text === "/tool" || text.startsWith("/tool ")) {
    const parsed = parseToolArgs(text.slice("/tool".length));
    if ("error" in parsed) {
      return { handled: true, text: parsed.error, ok: false };
    }
    try {
      const result = await gateway.runTool({
        sessionId: session.sessionId,
        toolName: parsed.toolName,
        input: parsed.input
      });
      return { handled: true, text: formatToolResult(result), ok: result.ok };
    } catch (error) {
      return { handled: true, text: toErrorText(error), ok: false };
    }
  }

  if (text === "/restart") {
    try {
      const result = await gateway.requestRestart({
        intent: "manual",
        reason: "/restart command from channel"
      });
      if (result && typeof result === "object" && "ok" in result && result.ok === false) {
        return {
          handled: true,
          text: `Restart blocked: ${result.message ?? "unknown reason"}`,
          ok: false
        };
      }
      return { handled: true, text: "Restart initiated.", ok: true };
    } catch (error) {
      return { handled: true, text: toErrorText(error), ok: false };
    }
  }

  return { handled: false, text: "" };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatHelp(): string {
  return [
    "Available commands:",
    "  /status          - Gateway status",
    "  /providers       - List provider profiles",
    "  /provider <id>   - Switch provider for next turn",
    "  /session         - Current session info",
    "  /sessions        - List all sessions",
    "  /new             - Start a new session (clear current)",
    "  /tools           - List loaded tools",
    "  /tool <name> [json] - Run a tool",
    "  /restart         - Restart the gateway",
    "  /help            - Show this help"
  ].join("\n");
}

function formatStatus(status: GatewayStatus): string {
  const lines = [`Gateway: ${status.state}`];
  if (status.startedAt) {
    lines.push(`Started: ${status.startedAt}`);
  }
  for (const reason of status.degradedReasons) {
    lines.push(`Degraded: ${reason}`);
  }
  if (status.agent?.name) {
    lines.push(`Agent: ${status.agent.name}`);
  }
  if (status.healthUrl) {
    lines.push(`Health: ${status.healthUrl}`);
  }
  return lines.join("\n");
}

function formatProviders(profiles: ProviderProfile[]): string {
  if (profiles.length === 0) {
    return "No provider profiles configured.";
  }
  return profiles
    .map((p) => `${p.id} (${p.kind}, model=${p.model})`)
    .join("\n");
}

function formatSessions(
  snapshots: SessionSnapshot[],
  currentSessionId: string
): string {
  if (snapshots.length === 0) {
    return "No active sessions.";
  }
  return snapshots
    .map((s) => {
      const marker = s.sessionId === currentSessionId ? "* " : "  ";
      const busy = s.turnInProgress ? " [busy]" : "";
      return `${marker}${s.sessionId} provider=${s.activeProviderId} messages=${s.historyCount}${busy}`;
    })
    .join("\n");
}

function formatSessionInfo(
  sessionId: string,
  state: { activeProviderId: string; pendingProviderId?: string } | null
): string {
  if (!state) {
    return `Session: ${sessionId} (no state)`;
  }
  const lines = [
    `Session: ${sessionId}`,
    `Provider: ${state.activeProviderId}`
  ];
  if (state.pendingProviderId) {
    lines.push(`Pending: ${state.pendingProviderId}`);
  }
  return lines.join("\n");
}

function formatTools(toolNames: string[]): string {
  if (toolNames.length === 0) {
    return "No tools loaded.";
  }
  return `Loaded tools: ${toolNames.join(", ")}`;
}

function formatToolResult(result: ToolRunResult): string {
  if (result.ok) {
    const output =
      result.output === null || result.output === undefined
        ? String(result.output)
        : typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output, null, 2);
    return output;
  }
  let message = `Error (${result.error?.code ?? "unknown"}): ${result.error?.message ?? "unknown error"}`;
  if (result.error?.issues && result.error.issues.length > 0) {
    for (const issue of result.error.issues) {
      message += `\n  ${issue.path}: ${issue.message}`;
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseToolArgs(
  raw: string
): { toolName: string; input: unknown } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "Usage: /tool <name> [json]" };
  }
  const firstSpace = trimmed.indexOf(" ");
  const toolName =
    firstSpace >= 0 ? trimmed.slice(0, firstSpace).trim() : trimmed;
  const rawJson = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";
  if (!toolName) {
    return { error: "Usage: /tool <name> [json]" };
  }
  if (!rawJson) {
    return { toolName, input: {} };
  }
  try {
    return { toolName, input: JSON.parse(rawJson) };
  } catch (error) {
    return {
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
