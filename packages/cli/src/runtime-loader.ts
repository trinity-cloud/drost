import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayConfig } from "@drost/core";
import { runStartLoop, type StartUiMode } from "./start.js";
import { importTypeScriptModule, unwrapModuleDefault } from "./module-loader.js";

export interface ProjectRuntimeStartParams {
  projectRoot: string;
  config: GatewayConfig;
  pidFilePath: string;
  uiMode: StartUiMode;
  reloadConfigOnRestart?: () => Promise<GatewayConfig>;
  runDefault: (overrides?: {
    config?: GatewayConfig;
    pidFilePath?: string;
    uiMode?: StartUiMode;
  }) => Promise<number>;
}

export interface ProjectRuntimeModule {
  start?: (params: ProjectRuntimeStartParams) => Promise<number> | number;
}

function nowToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importModuleWithCacheBust(filePath: string): Promise<unknown> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return await importTypeScriptModule(filePath);
  }
  return await import(`${pathToFileURL(filePath).href}?v=${nowToken()}`);
}

function normalizeRuntimeModule(value: unknown): ProjectRuntimeModule {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as { start?: unknown };
  if (record.start !== undefined && typeof record.start !== "function") {
    throw new Error("Invalid runtime module: start must be a function when provided");
  }
  const start =
    typeof record.start === "function"
      ? (record.start as (params: ProjectRuntimeStartParams) => Promise<number> | number)
      : undefined;
  return {
    start
  };
}

async function loadProjectRuntimeModule(entryPath: string): Promise<ProjectRuntimeModule> {
  const loaded = await importModuleWithCacheBust(entryPath);
  const loadedRecord = loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : undefined;
  const candidate = loadedRecord?.runtime ?? loadedRecord?.default ?? loaded;
  return normalizeRuntimeModule(unwrapModuleDefault(candidate));
}

function resolveRuntimeEntryPath(projectRoot: string, config: GatewayConfig): string | null {
  const configured = config.runtime?.entry?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(projectRoot, configured);
  }
  return null;
}

export async function runProjectRuntime(params: {
  projectRoot: string;
  config: GatewayConfig;
  pidFilePath: string;
  uiMode: StartUiMode;
  reloadConfigOnRestart?: () => Promise<GatewayConfig>;
  runDefaultStartLoop?: typeof runStartLoop;
}): Promise<number> {
  const runDefaultStartLoop = params.runDefaultStartLoop ?? runStartLoop;
  const runDefault = async (overrides?: {
    config?: GatewayConfig;
    pidFilePath?: string;
    uiMode?: StartUiMode;
  }): Promise<number> =>
    await runDefaultStartLoop({
      config: overrides?.config ?? params.config,
      pidFilePath: overrides?.pidFilePath ?? params.pidFilePath,
      uiMode: overrides?.uiMode ?? params.uiMode,
      reloadConfigOnRestart: params.reloadConfigOnRestart
    });

  const entryPath = resolveRuntimeEntryPath(params.projectRoot, params.config);
  if (!entryPath) {
    return await runDefault();
  }
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new Error(`Runtime entry file not found: ${entryPath}`);
  }

  const module = await loadProjectRuntimeModule(entryPath);
  if (!module.start) {
    return await runDefault();
  }

  const code = await module.start({
    projectRoot: params.projectRoot,
    config: params.config,
    pidFilePath: params.pidFilePath,
    uiMode: params.uiMode,
    reloadConfigOnRestart: params.reloadConfigOnRestart,
    runDefault
  });
  if (!Number.isFinite(code)) {
    throw new Error(`Runtime start() must return a numeric exit code. Received: ${String(code)}`);
  }
  return code;
}
