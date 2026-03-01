import type { GatewayRuntime } from "@drost/core";
import { renderCommandHints, renderGatewayBoot, renderSessionSummary } from "@drost/tui";
import { parseToolCommand } from "../runtime-common.js";
import { normalizeEventLine, summarizeSessions } from "./helpers.js";

export function handleTuiCommand(params: {
  rawText: string;
  hasProviders: boolean;
  gateway: GatewayRuntime;
  restartCount: number;
  activeSessionId: string;
  setActiveSessionId: (sessionId: string) => void;
  pushEvents: (lines: string[]) => void;
  forceRender: () => void;
  runToolInvocation: (toolName: string, input: unknown) => void;
  runTextTurn: (text: string) => void;
}): void {
  const text = params.rawText.trim();
  if (!text) {
    return;
  }

  if (text === "/help") {
    params.pushEvents([renderCommandHints()]);
    return;
  }

  if (text === "/restart") {
    void params.gateway
      .requestRestart({
        intent: "manual",
        reason: "/restart command"
      })
      .then((result) => {
        if (result && typeof result === "object" && "ok" in result && result.ok === false) {
          params.pushEvents([`restart blocked: ${result.message}`]);
        }
      })
      .catch((error) => {
        params.pushEvents([error instanceof Error ? error.message : String(error)]);
      });
    return;
  }

  if (text.startsWith("/provider ")) {
    const providerId = text.slice("/provider ".length).trim();
    if (!providerId) {
      params.pushEvents(["provider id required"]);
      return;
    }
    if (!params.hasProviders) {
      params.pushEvents(["no providers configured in drost.config.*"]);
      return;
    }
    try {
      params.gateway.queueSessionProviderSwitch(params.activeSessionId, providerId);
      const session = params.gateway.getSessionState(params.activeSessionId);
      params.pushEvents([
        `provider queued for next turn in session ${params.activeSessionId}: ${providerId} (active: ${session?.activeProviderId ?? "n/a"})`
      ]);
    } catch (error) {
      params.pushEvents([error instanceof Error ? error.message : String(error)]);
    }
    return;
  }

  if (text === "/session") {
    if (!params.hasProviders) {
      params.pushEvents(["no providers configured in drost.config.*"]);
      return;
    }
    const session = params.gateway.getSessionState(params.activeSessionId);
    params.pushEvents([
      `active session=${params.activeSessionId} provider=${session?.activeProviderId ?? "n/a"} pending=${session?.pendingProviderId ?? "(none)"}`
    ]);
    return;
  }

  if (text.startsWith("/session ")) {
    if (!params.hasProviders) {
      params.pushEvents(["no providers configured in drost.config.*"]);
      return;
    }
    const nextSessionId = text.slice("/session ".length).trim();
    if (!nextSessionId) {
      params.pushEvents(["session id required"]);
      return;
    }
    if (!params.gateway.sessionExists(nextSessionId)) {
      params.pushEvents([`unknown session: ${nextSessionId}`]);
      return;
    }
    try {
      params.gateway.ensureSession(nextSessionId);
      params.setActiveSessionId(nextSessionId);
      const session = params.gateway.getSessionState(nextSessionId);
      params.pushEvents([
        `active session switched to ${nextSessionId} (provider=${session?.activeProviderId ?? "n/a"})`
      ]);
      params.forceRender();
    } catch (error) {
      params.pushEvents([error instanceof Error ? error.message : String(error)]);
    }
    return;
  }

  if (text === "/sessions") {
    if (!params.hasProviders) {
      params.pushEvents(["no providers configured in drost.config.*"]);
      return;
    }
    params.pushEvents(
      renderSessionSummary(summarizeSessions(params.gateway, params.activeSessionId).slice(0, 10)).map((line) =>
        normalizeEventLine(line)
      )
    );
    return;
  }

  if (text === "/new") {
    if (!params.hasProviders) {
      params.pushEvents(["no providers configured in drost.config.*"]);
      return;
    }
    try {
      const nextSessionId = params.gateway.createSession({
        channel: "local",
        fromSessionId: params.activeSessionId
      });
      params.setActiveSessionId(nextSessionId);
      const session = params.gateway.getSessionState(nextSessionId);
      params.pushEvents([
        `active session switched to ${nextSessionId} (provider=${session?.activeProviderId ?? "n/a"})`
      ]);
      params.forceRender();
    } catch (error) {
      params.pushEvents([error instanceof Error ? error.message : String(error)]);
    }
    return;
  }

  if (text === "/status") {
    const status = params.gateway.getStatus();
    const lines = renderGatewayBoot({
      state: status.state,
      startedAt: status.startedAt,
      degradedReasons: status.degradedReasons,
      restartCount: params.restartCount,
      healthUrl: status.healthUrl
    }).map((line) => normalizeEventLine(line));

    if (params.hasProviders) {
      lines.push(
        ...renderSessionSummary(summarizeSessions(params.gateway, params.activeSessionId).slice(0, 10)).map((line) =>
          normalizeEventLine(line)
        )
      );
    }
    params.pushEvents(lines);
    return;
  }

  if (text === "/providers") {
    const profiles = params.gateway.listProviderProfiles();
    if (profiles.length === 0) {
      params.pushEvents(["no provider profiles configured"]);
      return;
    }
    params.pushEvents(
      profiles.map(
        (profile) =>
          `provider=${profile.id} kind=${profile.kind} model=${profile.model} auth=${profile.authProfileId}`
      )
    );
    return;
  }

  if (text === "/tools") {
    const toolNames = params.gateway.listLoadedToolNames();
    if (toolNames.length === 0) {
      params.pushEvents(["no tools loaded"]);
      return;
    }
    params.pushEvents([`loaded tools: ${toolNames.join(", ")}`]);
    return;
  }

  if (text.startsWith("/tool ")) {
    const parsed = parseToolCommand(text.slice("/tool ".length));
    if ("error" in parsed) {
      params.pushEvents([parsed.error]);
      return;
    }
    params.runToolInvocation(parsed.toolName, parsed.input);
    return;
  }

  params.runTextTurn(text);
}
