import {
  RESTART_EXIT_CODE,
  createGateway,
  type GatewayConfig
} from "@drost/core";
import { renderGatewayBoot } from "@drost/tui";
import {
  print,
  removePidFile,
  writePidFile
} from "./runtime-common.js";

export async function runGatewayCyclePlain(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  let settled = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (code: number): void => {
    if (settled) {
      return;
    }
    settled = true;
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
    print("[drost] server mode active. Use channels/control API/health endpoint.");
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

  // Keep the process alive in server mode so signals can control lifecycle.
  keepAliveTimer = setInterval(() => {}, 60_000);

  const exitCode = await exitPromise;
  if (exitCode !== RESTART_EXIT_CODE) {
    removePidFile(params.pidFilePath);
  }
  return exitCode;
}
