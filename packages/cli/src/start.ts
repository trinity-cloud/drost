import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  RESTART_EXIT_CODE,
  createGateway,
  type GatewayConfig,
  type GatewayRuntime
} from "@drost/core";
import { renderCommandHints, renderGatewayBoot, renderSessionSummary, renderStreamEvent } from "@drost/tui";
import { runGatewayCycleTuiInk } from "./tui-ink.js";

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function parseToolCommand(raw: string): { toolName: string; input: unknown } | { error: string } {
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

function summarizeToolValue(value: unknown): string {
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

function writePidFile(pidFilePath: string): void {
  ensurePidDir(pidFilePath);
  fs.writeFileSync(pidFilePath, `${process.pid}\n`);
}

function removePidFile(pidFilePath: string): void {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // best effort
  }
}

function loadSessions(gateway: GatewayRuntime, activeSessionId: string): void {
  gateway.ensureSession(activeSessionId);
  const persistedSessionIds = gateway.listPersistedSessionIds();
  for (const sessionId of persistedSessionIds) {
    if (sessionId === activeSessionId) {
      continue;
    }
    gateway.ensureSession(sessionId);
  }
}

function buildSessionSummaries(gateway: GatewayRuntime, activeSessionId: string): Array<{
  sessionId: string;
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  historyCount: number;
  active: boolean;
}> {
  return gateway
    .listSessionSnapshots()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((session) => ({
      ...session,
      active: session.sessionId === activeSessionId
    }));
}

async function runGatewayCyclePlain(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  let settled = false;
  let turnInFlight = false;
  let rl: readline.Interface | null = null;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let activeSessionId = "local";

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (code: number): void => {
    if (settled) {
      return;
    }
    settled = true;
    rl?.close();
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("SIGUSR2", onSigUsr2);
    resolveExit(code);
  };

  const gateway = createGateway(params.config, {
    exit: (code) => {
      settle(code);
    }
  });

  await gateway.start();
  writePidFile(params.pidFilePath);

  const status = gateway.getStatus();
  for (const line of renderGatewayBoot({
    state: status.state,
    startedAt: status.startedAt,
    degradedReasons: status.degradedReasons,
    restartCount: params.restartCount,
    healthUrl: status.healthUrl
  })) {
    print(line);
  }
  if (status.toolDiagnostics) {
    const diagnostics = status.toolDiagnostics;
    print(
      `[drost] tools: built-in=${diagnostics.loadedBuiltInCount} custom=${diagnostics.loadedCustomCount} skipped=${diagnostics.skipped.length}`
    );
    for (const skipped of diagnostics.skipped) {
      print(
        `[drost] tool skipped: file=${skipped.filePath} reason=${skipped.reason} message=${skipped.message}`
      );
    }
  }
  if (status.providerDiagnostics && status.providerDiagnostics.length > 0) {
    for (const probe of status.providerDiagnostics) {
      print(
        `[drost] probe: provider=${probe.providerId} ok=${probe.ok} code=${probe.code} message=${probe.message}`
      );
    }
  }

  const hasProviders = Boolean(params.config.providers && params.config.providers.profiles.length > 0);
  if (hasProviders) {
    loadSessions(gateway, activeSessionId);
    print("[drost] local session ready.");
    print(renderCommandHints());
    for (const line of renderSessionSummary(buildSessionSummaries(gateway, activeSessionId))) {
      print(line);
    }
  } else {
    print("[drost] no providers configured. Waiting for signals.");
  }

  const onSigInt = async (): Promise<void> => {
    await gateway.stop();
    settle(0);
  };

  const onSigTerm = async (): Promise<void> => {
    await gateway.stop();
    settle(0);
  };

  const onSigUsr2 = async (): Promise<void> => {
    await gateway.requestRestart({
      intent: "signal",
      reason: "SIGUSR2"
    });
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGUSR2", onSigUsr2);

  if (process.stdin.isTTY) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> "
    });

    rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) {
        rl?.prompt();
        return;
      }

      if (text === "/help") {
        print(renderCommandHints());
        rl?.prompt();
        return;
      }

      if (text === "/restart") {
        const result = await gateway.requestRestart({
          intent: "manual",
          reason: "/restart command"
        });
        if (result && typeof result === "object" && "ok" in result && result.ok === false) {
          print(`[drost] restart blocked: ${result.message}`);
          rl?.prompt();
        }
        return;
      }

      if (text.startsWith("/provider ")) {
        const providerId = text.slice("/provider ".length).trim();
        if (!providerId) {
          print("[drost] provider id required");
          rl?.prompt();
          return;
        }
        if (!hasProviders) {
          print("[drost] no providers configured in drost.config.*");
          rl?.prompt();
          return;
        }
        try {
          gateway.queueSessionProviderSwitch(activeSessionId, providerId);
          const session = gateway.getSessionState(activeSessionId);
          print(
            `[drost] provider queued for next turn in session ${activeSessionId}: ${providerId} (active: ${session?.activeProviderId ?? "n/a"})`
          );
        } catch (error) {
          print(`[drost] ${error instanceof Error ? error.message : String(error)}`);
        }
        rl?.prompt();
        return;
      }

      if (text === "/session") {
        if (!hasProviders) {
          print("[drost] no providers configured in drost.config.*");
          rl?.prompt();
          return;
        }
        const session = gateway.getSessionState(activeSessionId);
        print(
          `[drost] active session=${activeSessionId} provider=${session?.activeProviderId ?? "n/a"} pending=${session?.pendingProviderId ?? "(none)"}`
        );
        rl?.prompt();
        return;
      }

      if (text.startsWith("/session ")) {
        if (!hasProviders) {
          print("[drost] no providers configured in drost.config.*");
          rl?.prompt();
          return;
        }
        const nextSessionId = text.slice("/session ".length).trim();
        if (!nextSessionId) {
          print("[drost] session id required");
          rl?.prompt();
          return;
        }
        try {
          gateway.ensureSession(nextSessionId);
          activeSessionId = nextSessionId;
          const session = gateway.getSessionState(activeSessionId);
          print(
            `[drost] active session switched to ${activeSessionId} (provider=${session?.activeProviderId ?? "n/a"})`
          );
        } catch (error) {
          print(`[drost] ${error instanceof Error ? error.message : String(error)}`);
        }
        rl?.prompt();
        return;
      }

      if (text === "/sessions") {
        if (!hasProviders) {
          print("[drost] no providers configured in drost.config.*");
          rl?.prompt();
          return;
        }
        for (const line of renderSessionSummary(buildSessionSummaries(gateway, activeSessionId))) {
          print(line);
        }
        rl?.prompt();
        return;
      }

      if (text === "/status") {
        const currentStatus = gateway.getStatus();
        for (const line of renderGatewayBoot({
          state: currentStatus.state,
          startedAt: currentStatus.startedAt,
          degradedReasons: currentStatus.degradedReasons,
          restartCount: params.restartCount,
          healthUrl: currentStatus.healthUrl
        })) {
          print(line);
        }
        if (hasProviders) {
          for (const line of renderSessionSummary(buildSessionSummaries(gateway, activeSessionId))) {
            print(line);
          }
        }
        rl?.prompt();
        return;
      }

      if (text === "/providers") {
        const profiles = gateway.listProviderProfiles();
        if (profiles.length === 0) {
          print("[drost] no provider profiles configured");
        } else {
          for (const profile of profiles) {
            print(
              `[drost] provider=${profile.id} kind=${profile.kind} model=${profile.model} auth=${profile.authProfileId}`
            );
          }
        }
        rl?.prompt();
        return;
      }

      if (text === "/tools") {
        const toolNames = gateway.listLoadedToolNames();
        if (toolNames.length === 0) {
          print("[drost] no tools loaded");
        } else {
          print(`[drost] loaded tools: ${toolNames.join(", ")}`);
        }
        rl?.prompt();
        return;
      }

      if (text.startsWith("/tool ")) {
        const parsed = parseToolCommand(text.slice("/tool ".length));
        if ("error" in parsed) {
          print(`[drost] ${parsed.error}`);
          rl?.prompt();
          return;
        }

        const result = await gateway.runTool({
          sessionId: activeSessionId,
          toolName: parsed.toolName,
          input: parsed.input,
          onEvent: (event) => {
            print(
              renderStreamEvent({
                type: event.type,
                sessionId: event.sessionId,
                providerId: event.providerId,
                payload: {
                  text: event.payload.text,
                  error: event.payload.error,
                  toolName: event.payload.toolName,
                  metadata: event.payload.metadata,
                  usage: event.payload.usage
                }
              })
            );
          }
        });

        if (result.ok) {
          print(`[drost] tool ${result.toolName} output: ${summarizeToolValue(result.output)}`);
        } else {
          print(`[drost] tool ${result.toolName} ${result.error?.code ?? "error"}: ${result.error?.message ?? "unknown error"}`);
          if (result.error?.issues && result.error.issues.length > 0) {
            for (const issue of result.error.issues) {
              print(`[drost]   issue ${issue.path}: ${issue.message}`);
            }
          }
        }
        rl?.prompt();
        return;
      }

      if (!hasProviders) {
        print("[drost] no providers configured in drost.config.*");
        rl?.prompt();
        return;
      }

      if (turnInFlight) {
        print("[drost] turn already in progress");
        rl?.prompt();
        return;
      }

      turnInFlight = true;
      try {
        await gateway.runSessionTurn({
          sessionId: activeSessionId,
          input: text,
          onEvent: (event) => {
            print(
              renderStreamEvent({
                type: event.type,
                sessionId: event.sessionId,
                providerId: event.providerId,
                payload: {
                  text: event.payload.text,
                  error: event.payload.error,
                  toolName: event.payload.toolName,
                  metadata: event.payload.metadata,
                  usage: event.payload.usage
                }
              })
            );
          }
        });
      } catch (error) {
        print(`[drost] ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        turnInFlight = false;
        rl?.prompt();
      }
    });

    rl.prompt();
  } else {
    // Keep the process alive in non-interactive mode so signals can control lifecycle.
    keepAliveTimer = setInterval(() => {}, 60_000);
  }

  const exitCode = await exitPromise;
  if (exitCode !== RESTART_EXIT_CODE) {
    removePidFile(params.pidFilePath);
  }
  return exitCode;
}

async function runGatewayCycleTui(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  return runGatewayCycleTuiInk(params);
}

export type StartUiMode = "auto" | "plain" | "tui";

function resolveRuntimeUiMode(uiMode: StartUiMode): "plain" | "tui" {
  if (uiMode === "plain") {
    return "plain";
  }
  if (uiMode === "tui") {
    return process.stdin.isTTY && process.stdout.isTTY ? "tui" : "plain";
  }
  return process.stdin.isTTY && process.stdout.isTTY ? "tui" : "plain";
}

export async function runStartLoop(params: {
  config: GatewayConfig;
  pidFilePath: string;
  uiMode?: StartUiMode;
  reloadConfigOnRestart?: () => Promise<GatewayConfig>;
}): Promise<number> {
  let restartCount = 0;
  let warnedTuiFallback = false;
  let runtimeConfig = params.config;
  while (true) {
    const requestedUiMode = params.uiMode ?? "auto";
    const runtimeUiMode = resolveRuntimeUiMode(requestedUiMode);
    if (requestedUiMode === "tui" && runtimeUiMode !== "tui" && !warnedTuiFallback) {
      warnedTuiFallback = true;
      print("[drost] --ui tui requested without TTY; falling back to plain mode.");
    }

    const exitCode =
      runtimeUiMode === "tui"
        ? await runGatewayCycleTui({
            config: runtimeConfig,
            pidFilePath: params.pidFilePath,
            restartCount
          })
        : await runGatewayCyclePlain({
            config: runtimeConfig,
            pidFilePath: params.pidFilePath,
            restartCount
          });

    if (exitCode === RESTART_EXIT_CODE) {
      restartCount += 1;
      print(`[drost] restart requested (count=${restartCount})`);
      if (params.reloadConfigOnRestart) {
        try {
          runtimeConfig = await params.reloadConfigOnRestart();
          const providerCount = runtimeConfig.providers?.profiles.length ?? 0;
          print(`[drost] config reloaded (providers=${providerCount})`);
        } catch (error) {
          print(
            `[drost] config reload failed; continuing with previous config: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      continue;
    }
    return exitCode;
  }
}
