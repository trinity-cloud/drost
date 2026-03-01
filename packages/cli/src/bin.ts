#!/usr/bin/env node

import path from "node:path";
import { initProject } from "./init.js";
import { migrateProjectRuntime } from "./init.js";
import { loadCliConfig } from "./config.js";
import { runStartLoop } from "./start.js";
import { sendRestartSignal } from "./restart.js";
import { runAuthCommand } from "./auth.js";
import { runProvidersCommand } from "./providers.js";
import { runToolCommand } from "./tool.js";
import { runProjectRuntime } from "./runtime-loader.js";
import type { StartUiMode } from "./start.js";

function printHelp(): void {
  process.stdout.write(
    [
      "drost commands:",
      "  drost init <name>",
      "  drost migrate runtime [path]",
      "  drost start [--ui <plain|tui>]",
      "  drost restart",
      "  drost auth doctor",
      "  drost auth codex-import [profileId] [--path /path/to/auth.json]",
      "  drost auth set-api-key <provider> <profileId> <apiKey>",
      "  drost auth set-token <provider> <profileId> <token>",
      "  drost auth set-setup-token <profileId> <token>",
      "  drost auth list",
      "  drost providers list",
      "  drost providers probe [timeoutMs]",
      "  drost tool list-templates",
      "  drost tool new <name> [--template <id>]"
    ].join("\n") + "\n"
  );
}

function parseStartUiMode(args: string[]): { uiMode: StartUiMode; ok: boolean } {
  let uiMode: StartUiMode = "plain";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    let candidate: string | undefined;
    if (token === "--ui") {
      candidate = args[i + 1];
      i += 1;
    } else if (token.startsWith("--ui=")) {
      candidate = token.slice("--ui=".length);
    } else {
      process.stderr.write(`Unknown start option: ${token}\n`);
      return { uiMode, ok: false };
    }

    if (candidate === "auto") {
      uiMode = "plain";
      continue;
    }

    if (candidate === "plain" || candidate === "tui") {
      uiMode = candidate;
      continue;
    }

    process.stderr.write(`Invalid --ui value: ${candidate ?? ""}. Expected plain|tui.\n`);
    return { uiMode, ok: false };
  }

  return { uiMode, ok: true };
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const targetName = args[0] ?? "my-drost-agent";
    const result = initProject(targetName);
    if (!result.created) {
      process.stderr.write(`Path already exists: ${result.projectPath}\n`);
      return 1;
    }
    process.stdout.write(`Initialized project at ${result.projectPath}\n`);
    process.stdout.write(`Next: cd ${targetName} && drost start\n`);
    return 0;
  }

  if (command === "migrate") {
    const [scope, targetPath = "."] = args;
    if (scope !== "runtime") {
      process.stderr.write(`Unknown migrate target: ${scope ?? "(missing)"}\n`);
      process.stderr.write("Usage: drost migrate runtime [path]\n");
      return 1;
    }

    const resolvedTarget = path.resolve(process.cwd(), targetPath);
    const result = migrateProjectRuntime(resolvedTarget);
    if (result.createdFiles.length === 0) {
      process.stdout.write(`No runtime scaffold changes needed in ${result.projectPath}\n`);
      return 0;
    }

    process.stdout.write(`Migrated runtime scaffold in ${result.projectPath}\n`);
    for (const file of result.createdFiles) {
      process.stdout.write(`  + ${file}\n`);
    }
    return 0;
  }

  const loadedConfig = await loadCliConfig();

  if (command === "start") {
    const parsed = parseStartUiMode(args);
    if (!parsed.ok) {
      return 1;
    }
    return await runProjectRuntime({
      projectRoot: loadedConfig.projectRoot,
      config: loadedConfig.gatewayConfig,
      pidFilePath: loadedConfig.pidFilePath,
      uiMode: parsed.uiMode,
      reloadConfigOnRestart: async () => {
        const refreshed = await loadCliConfig(loadedConfig.projectRoot);
        return refreshed.gatewayConfig;
      },
      runDefaultStartLoop: runStartLoop
    });
  }

  if (command === "restart") {
    const result = sendRestartSignal(loadedConfig.pidFilePath);
    const output = `${result.message}\n`;
    if (result.ok) {
      process.stdout.write(output);
      return 0;
    }
    process.stderr.write(output);
    return 1;
  }

  if (command === "auth") {
    return runAuthCommand(args, loadedConfig.gatewayConfig);
  }

  if (command === "providers") {
    return await runProvidersCommand(args, loadedConfig.gatewayConfig);
  }

  if (command === "tool") {
    return runToolCommand(args, loadedConfig.gatewayConfig);
  }

  printHelp();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
