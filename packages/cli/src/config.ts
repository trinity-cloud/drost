import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayConfig } from "@drost/core";
import { parse as parseDotEnv } from "dotenv";
import { importTypeScriptModule, unwrapModuleDefault } from "./module-loader.js";

export interface LoadedCliConfig {
  projectRoot: string;
  configPath: string | null;
  gatewayConfig: GatewayConfig;
  pidFilePath: string;
}

const CONFIG_CANDIDATES = [
  "drost.config.ts",
  "drost.config.mts",
  "drost.config.js",
  "drost.config.mjs",
  "drost.config.json"
];

function resolveMaybePath(projectRoot: string, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(projectRoot, filePath);
}

function resolveMaybePathList(projectRoot: string, filePaths: string[] | undefined): string[] | undefined {
  if (!filePaths) {
    return undefined;
  }
  return filePaths.map((entry) => resolveMaybePath(projectRoot, entry) ?? entry);
}

function loadProjectEnvFiles(projectRoot: string): void {
  // Keep explicit shell/CI env vars authoritative over local files.
  const shellDefined = new Set(Object.keys(process.env));
  const merged: Record<string, string> = {};
  for (const candidate of [".env", ".env.local"]) {
    const filePath = path.join(projectRoot, candidate);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    const parsed = parseDotEnv(fs.readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (shellDefined.has(key)) {
      continue;
    }
    process.env[key] = value;
  }
}

async function readConfigFile(configPath: string): Promise<GatewayConfig> {
  if (configPath.endsWith(".json")) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayConfig;
    return parsed;
  }

  const loaded = configPath.endsWith(".ts") || configPath.endsWith(".mts")
    ? await importTypeScriptModule(configPath)
    : await import(pathToFileURL(configPath).href);
  const loadedRecord = loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : undefined;
  const config = unwrapModuleDefault(loadedRecord?.config ?? loadedRecord?.default ?? loaded) as GatewayConfig;
  if (!config || typeof config !== "object") {
    throw new Error(`Invalid config export from ${configPath}`);
  }
  return config;
}

function normalizeConfig(projectRoot: string, config: GatewayConfig): GatewayConfig {
  const workspaceDir = resolveMaybePath(projectRoot, config.workspaceDir) ?? path.join(projectRoot, "workspace");
  const toolDirectory = resolveMaybePath(projectRoot, config.toolDirectory);
  const authStorePath = resolveMaybePath(projectRoot, config.authStorePath);
  const sessionDirectory = resolveMaybePath(projectRoot, config.sessionStore?.directory);
  const agentEntry = resolveMaybePath(projectRoot, config.agent?.entry);
  const runtimeEntry = resolveMaybePath(projectRoot, config.runtime?.entry);

  const mutableRoots =
    resolveMaybePathList(projectRoot, config.evolution?.mutableRoots) ?? [workspaceDir];

  const evolutionConfig = config.evolution
    ? {
        ...config.evolution,
        mutableRoots
      }
    : mutableRoots.length > 0
      ? {
          mutableRoots
        }
      : undefined;

  return {
    ...config,
    workspaceDir,
    toolDirectory,
    authStorePath,
    runtime: config.runtime
      ? {
          ...config.runtime,
          entry: runtimeEntry
        }
      : undefined,
    agent: config.agent
      ? {
          ...config.agent,
          entry: agentEntry
        }
      : undefined,
    evolution: evolutionConfig,
    sessionStore: config.sessionStore
      ? {
          ...config.sessionStore,
          directory: sessionDirectory
        }
      : undefined
  };
}

export async function loadCliConfig(projectRoot = process.cwd()): Promise<LoadedCliConfig> {
  const resolvedRoot = path.resolve(projectRoot);
  loadProjectEnvFiles(resolvedRoot);
  let configPath: string | null = null;
  for (const candidate of CONFIG_CANDIDATES) {
    const absolute = path.join(resolvedRoot, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      configPath = absolute;
      break;
    }
  }

  let rawConfig: GatewayConfig;
  if (configPath) {
    rawConfig = await readConfigFile(configPath);
  } else {
    rawConfig = {
      workspaceDir: resolvedRoot
    };
  }

  const gatewayConfig = normalizeConfig(resolvedRoot, rawConfig);
  const pidFilePath = path.join(resolvedRoot, ".drost", "gateway.pid");

  return {
    projectRoot: resolvedRoot,
    configPath,
    gatewayConfig,
    pidFilePath
  };
}
