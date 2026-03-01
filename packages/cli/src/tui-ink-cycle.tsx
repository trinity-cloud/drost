import { render, type Instance } from "ink";
import React from "react";
import {
  RESTART_EXIT_CODE,
  createGateway,
  type GatewayConfig
} from "@drost/core";
import { removePidFile, writePidFile } from "./runtime-common.js";
import { GatewayInkApp } from "./tui-ink/app.js";

export async function runGatewayCycleTuiInk(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  let settled = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let inkApp: Instance | null = null;

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (code: number): void => {
    if (settled) {
      return;
    }

    settled = true;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("SIGUSR2", onSigUsr2);

    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    if (inkApp) {
      inkApp.unmount();
      inkApp = null;
    }

    resolveExit(code);
  };

  const gateway = createGateway(params.config, {
    exit: (code) => {
      settle(code);
    }
  });

  await gateway.start();
  writePidFile(params.pidFilePath);

  const hasProviders = Boolean(params.config.providers && params.config.providers.profiles.length > 0);

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

  if (process.stdin.isTTY && process.stdout.isTTY) {
    inkApp = render(
      <GatewayInkApp
        gateway={gateway}
        restartCount={params.restartCount}
        hasProviders={hasProviders}
        onInterrupt={() => {
          void onSigInt();
        }}
      />,
      {
        patchConsole: false,
        exitOnCtrlC: false
      }
    );
  } else {
    keepAliveTimer = setInterval(() => {}, 60_000);
  }

  const exitCode = await exitPromise;
  if (exitCode !== RESTART_EXIT_CODE) {
    removePidFile(params.pidFilePath);
  }
  return exitCode;
}
