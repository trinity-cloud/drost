import {
  RESTART_EXIT_CODE,
  type GatewayConfig
} from "@drost/core";
import { runGatewayCyclePlain } from "./gateway-cycle-plain.js";
import { print } from "./runtime-common.js";
import { runGatewayCycleTuiInk } from "./tui-ink.js";

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
