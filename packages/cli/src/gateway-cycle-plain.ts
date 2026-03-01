import path from "node:path";
import {
  RESTART_EXIT_CODE,
  createGateway,
  type GatewayConfig,
  type GatewayRuntimeEvent
} from "@drost/core";
import { renderGatewayBoot } from "@drost/tui";
import {
  print,
  removePidFile,
  writePidFile
} from "./runtime-common.js";

function truncateText(value: string, max = 220): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return truncateText(JSON.stringify(value));
  } catch {
    return truncateText(String(value));
  }
}

function formatRuntimeEvent(event: GatewayRuntimeEvent): string {
  const payloadRecord =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const keys = Object.keys(payloadRecord).sort((left, right) => left.localeCompare(right));
  const payloadSummary = keys
    .map((key) => `${key}=${summarizeValue(payloadRecord[key])}`)
    .join(" ");
  return `[drost][event] ${event.timestamp} ${event.type}${payloadSummary ? ` ${payloadSummary}` : ""}`;
}

function isAnthropicProfile(profile: {
  id: string;
  kind: string;
  adapterId: string;
  authProfileId: string;
}): boolean {
  return (
    profile.kind === "anthropic" ||
    profile.id.toLowerCase().includes("anthropic") ||
    profile.adapterId.toLowerCase().includes("anthropic") ||
    profile.authProfileId.toLowerCase().includes("anthropic")
  );
}

function isXaiProfile(profile: {
  id: string;
  baseUrl?: string;
  model: string;
  authProfileId: string;
}): boolean {
  return (
    profile.id.toLowerCase().includes("xai") ||
    profile.authProfileId.toLowerCase().includes("xai") ||
    profile.model.toLowerCase().includes("grok") ||
    (profile.baseUrl?.toLowerCase().includes("x.ai") ?? false)
  );
}

function missingAuthHint(profile: {
  id: string;
  kind: string;
  adapterId: string;
  baseUrl?: string;
  model: string;
  authProfileId: string;
}): string {
  if (profile.kind === "openai-codex") {
    return "hint=run `codex login` (or set up codex auth profile)";
  }
  if (isAnthropicProfile(profile)) {
    return "hint=set ANTHROPIC_SETUP_TOKEN in .env (or run `drost auth set-setup-token anthropic:default <token>`)";
  }
  if (isXaiProfile(profile)) {
    return "hint=set XAI_API_KEY in .env (or run `drost auth set-api-key openai-compatible openai-compatible:xai <key>`)";
  }
  return `hint=run \`drost auth set-api-key ${profile.kind} ${profile.authProfileId} <key>\``;
}

export async function runGatewayCyclePlain(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  let settled = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let unsubscribeRuntimeEvents: (() => void) | null = null;
  let gateway: ReturnType<typeof createGateway> | null = null;

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  async function onSigInt(): Promise<void> {
    if (gateway) {
      await gateway.stop();
    }
    settle(0);
  }

  async function onSigTerm(): Promise<void> {
    if (gateway) {
      await gateway.stop();
    }
    settle(0);
  }

  async function onSigUsr2(): Promise<void> {
    if (!gateway) {
      return;
    }
    await gateway.requestRestart({
      intent: "signal",
      reason: "SIGUSR2"
    });
  }

  const settle = (code: number): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (unsubscribeRuntimeEvents) {
      unsubscribeRuntimeEvents();
      unsubscribeRuntimeEvents = null;
    }
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("SIGUSR2", onSigUsr2);
    resolveExit(code);
  };

  gateway = createGateway(params.config, {
    exit: (code) => {
      settle(code);
    }
  });
  unsubscribeRuntimeEvents = gateway.onRuntimeEvent((event) => {
    print(formatRuntimeEvent(event));
  });
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGUSR2", onSigUsr2);

  await gateway.start();
  writePidFile(params.pidFilePath);

  const status = gateway.getStatus();
  const sessionDirectory = params.config.sessionStore?.directory ?? "sessions";
  const authStorePath = params.config.authStorePath ?? ".drost/auth-profiles.json";
  print(
    `[drost] runtime: node=${process.version} pid=${process.pid} cwd=${process.cwd()} workspace=${path.resolve(params.config.workspaceDir)}`
  );
  print(
    `[drost] storage: sessions=${path.resolve(sessionDirectory)} auth=${path.resolve(authStorePath)} pidFile=${params.pidFilePath}`
  );
  const channelIds = gateway.listChannelAdapterIds();
  print(
    `[drost] channels: ${channelIds.length > 0 ? channelIds.join(", ") : "(none)"} | providers=${gateway.listProviderProfiles().length}`
  );

  for (const line of renderGatewayBoot({
    state: status.state,
    startedAt: status.startedAt,
    degradedReasons: status.degradedReasons,
    restartCount: params.restartCount,
    healthUrl: status.healthUrl,
    controlUrl: status.controlUrl
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
    const providerById = new Map(
      gateway.listProviderProfiles().map((profile) => [profile.id, profile] as const)
    );
    for (const probe of status.providerDiagnostics) {
      const profile = providerById.get(probe.providerId);
      const hint =
        !probe.ok && probe.code === "missing_auth" && profile
          ? ` ${missingAuthHint(profile)}`
          : "";
      print(
        `[drost] probe: provider=${probe.providerId} ok=${probe.ok} code=${probe.code} message=${probe.message}${hint}`
      );
    }
  }

  const hasProviders = Boolean(params.config.providers && params.config.providers.profiles.length > 0);
  if (hasProviders) {
    print("[drost] server mode active. Use channels/control API/health endpoint.");
  } else {
    print("[drost] no providers configured. Waiting for signals.");
  }

  // Keep the process alive in server mode so signals can control lifecycle.
  keepAliveTimer = setInterval(() => {}, 60_000);

  const exitCode = await exitPromise;
  if (exitCode !== RESTART_EXIT_CODE) {
    removePidFile(params.pidFilePath);
  }
  return exitCode;
}
