import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentLifecycleContext } from "../agent.js";
import type { GatewayPluginsConfig } from "../config.js";
import { importTypeScriptModule, unwrapModuleDefault } from "../module-loader.js";
import type { PluginDefinition, PluginLoadDiagnostic, PluginRuntimeStatus, LoadedPlugin } from "./types.js";

function nowToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toAbsolute(workspaceDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value);
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedRoot = path.resolve(rootPath);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function importPluginModule(filePath: string): Promise<unknown> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return await importTypeScriptModule(filePath);
  }
  return await import(`${pathToFileURL(filePath).href}?v=${nowToken()}`);
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return false;
  }
  if (record.init !== undefined && typeof record.init !== "function") {
    return false;
  }
  if (record.start !== undefined && typeof record.start !== "function") {
    return false;
  }
  if (record.stop !== undefined && typeof record.stop !== "function") {
    return false;
  }
  if (record.hooks !== undefined && (typeof record.hooks !== "object" || record.hooks === null)) {
    return false;
  }
  if (record.tools !== undefined && !Array.isArray(record.tools)) {
    return false;
  }
  if (record.channels !== undefined && !Array.isArray(record.channels)) {
    return false;
  }
  return true;
}

export class PluginRuntime {
  private readonly workspaceDir: string;
  private readonly context: AgentLifecycleContext;
  private readonly config: GatewayPluginsConfig | undefined;
  private readonly loaded: LoadedPlugin[] = [];
  private readonly blocked: PluginLoadDiagnostic[] = [];
  private readonly runtimeErrors: Array<{
    pluginId: string;
    phase: "start" | "stop" | "beforeTurn" | "afterTurn" | "onToolResult";
    message: string;
  }> = [];

  constructor(params: {
    workspaceDir: string;
    context: AgentLifecycleContext;
    config?: GatewayPluginsConfig;
  }) {
    this.workspaceDir = path.resolve(params.workspaceDir);
    this.context = params.context;
    this.config = params.config;
  }

  private pushBlocked(diagnostic: PluginLoadDiagnostic): void {
    this.blocked.push(diagnostic);
  }

  private pushRuntimeError(pluginId: string, phase: "start" | "stop" | "beforeTurn" | "afterTurn" | "onToolResult", error: unknown): void {
    this.runtimeErrors.push({
      pluginId,
      phase,
      message: toErrorText(error)
    });
  }

  private allowlistSet(): Set<string> {
    return new Set(
      (this.config?.allowlist ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
  }

  private trustedRoots(): string[] {
    return (this.config?.trustedRoots ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => toAbsolute(this.workspaceDir, entry));
  }

  private configuredModulePaths(): string[] {
    return Array.from(
      new Set(
        (this.config?.modules ?? [])
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      )
    );
  }

  private isTrustedPath(modulePath: string, trustedRoots: string[]): boolean {
    if (trustedRoots.length === 0) {
      return true;
    }
    return trustedRoots.some((trustedRoot) => isWithinRoot(modulePath, trustedRoot));
  }

  async load(): Promise<void> {
    this.loaded.length = 0;
    this.blocked.length = 0;

    if (!(this.config?.enabled ?? false)) {
      return;
    }

    const allowlist = this.allowlistSet();
    const trustedRoots = this.trustedRoots();
    const seenPluginIds = new Set<string>();

    for (const configuredPath of this.configuredModulePaths()) {
      const absolutePath = toAbsolute(this.workspaceDir, configuredPath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        this.pushBlocked({
          modulePath: absolutePath,
          reason: "missing_module",
          message: "Plugin module file does not exist"
        });
        continue;
      }
      if (!this.isTrustedPath(absolutePath, trustedRoots)) {
        this.pushBlocked({
          modulePath: absolutePath,
          reason: "untrusted_path",
          message: "Plugin path is outside configured trusted roots"
        });
        continue;
      }

      let loadedValue: unknown;
      try {
        loadedValue = await importPluginModule(absolutePath);
      } catch (error) {
        this.pushBlocked({
          modulePath: absolutePath,
          reason: "load_error",
          message: toErrorText(error)
        });
        continue;
      }

      const loadedRecord =
        loadedValue && typeof loadedValue === "object" ? (loadedValue as Record<string, unknown>) : undefined;
      const candidate = loadedRecord?.plugin ?? loadedRecord?.default ?? loadedValue;
      const normalized = unwrapModuleDefault(candidate);
      if (!isPluginDefinition(normalized)) {
        this.pushBlocked({
          modulePath: absolutePath,
          reason: "invalid_shape",
          message: "Expected plugin export with id and optional lifecycle/hooks"
        });
        continue;
      }

      const plugin: PluginDefinition = {
        ...normalized,
        id: normalized.id.trim(),
        name: typeof normalized.name === "string" ? normalized.name : undefined,
        description: typeof normalized.description === "string" ? normalized.description : undefined,
        version: typeof normalized.version === "string" ? normalized.version : undefined,
        diagnostics: normalized.diagnostics,
        tools: Array.isArray(normalized.tools) ? [...normalized.tools] : undefined,
        channels: Array.isArray(normalized.channels) ? [...normalized.channels] : undefined,
        hooks: normalized.hooks
      };

      if (allowlist.size > 0) {
        const allowById = allowlist.has(plugin.id);
        const allowByConfiguredPath = allowlist.has(configuredPath);
        const allowByAbsolutePath = allowlist.has(absolutePath);
        if (!allowById && !allowByConfiguredPath && !allowByAbsolutePath) {
          this.pushBlocked({
            modulePath: absolutePath,
            pluginId: plugin.id,
            reason: "allowlist_blocked",
            message: "Plugin is not present in plugins.allowlist"
          });
          continue;
        }
      }

      if (seenPluginIds.has(plugin.id)) {
        this.pushBlocked({
          modulePath: absolutePath,
          pluginId: plugin.id,
          reason: "duplicate_id",
          message: `Duplicate plugin id: ${plugin.id}`
        });
        continue;
      }

      if (plugin.init) {
        try {
          await plugin.init(this.context);
        } catch (error) {
          this.pushBlocked({
            modulePath: absolutePath,
            pluginId: plugin.id,
            reason: "init_failed",
            message: toErrorText(error)
          });
          continue;
        }
      }

      seenPluginIds.add(plugin.id);
      this.loaded.push({
        modulePath: absolutePath,
        definition: plugin
      });
    }
  }

  async start(): Promise<void> {
    for (const plugin of this.loaded) {
      if (!plugin.definition.start) {
        continue;
      }
      try {
        await plugin.definition.start(this.context);
      } catch (error) {
        this.pushRuntimeError(plugin.definition.id, "start", error);
      }
    }
  }

  async stop(): Promise<void> {
    for (let index = this.loaded.length - 1; index >= 0; index -= 1) {
      const plugin = this.loaded[index];
      if (!plugin?.definition.stop) {
        continue;
      }
      try {
        await plugin.definition.stop(this.context);
      } catch (error) {
        this.pushRuntimeError(plugin.definition.id, "stop", error);
      }
    }
  }

  listTools(): Array<{ pluginId: string; tools: PluginDefinition["tools"] }> {
    return this.loaded
      .filter((plugin) => Array.isArray(plugin.definition.tools) && plugin.definition.tools.length > 0)
      .map((plugin) => ({
        pluginId: plugin.definition.id,
        tools: plugin.definition.tools
      }));
  }

  listChannels(): Array<{ pluginId: string; channels: PluginDefinition["channels"] }> {
    return this.loaded
      .filter((plugin) => Array.isArray(plugin.definition.channels) && plugin.definition.channels.length > 0)
      .map((plugin) => ({
        pluginId: plugin.definition.id,
        channels: plugin.definition.channels
      }));
  }

  async runBeforeTurn(params: {
    sessionId: string;
    input: string;
    providerId?: string;
  }): Promise<string> {
    let input = params.input;
    for (const plugin of this.loaded) {
      const hook = plugin.definition.hooks?.beforeTurn;
      if (!hook) {
        continue;
      }
      try {
        const result = await hook({
          ...params,
          input,
          runtime: this.context
        });
        if (typeof result?.input === "string") {
          input = result.input;
        }
      } catch (error) {
        this.pushRuntimeError(plugin.definition.id, "beforeTurn", error);
      }
    }
    return input;
  }

  async runAfterTurn(params: {
    sessionId: string;
    input: string;
    providerId?: string;
    output: {
      historyCount: number;
      response?: string;
    };
  }): Promise<void> {
    for (let index = this.loaded.length - 1; index >= 0; index -= 1) {
      const plugin = this.loaded[index];
      const hook = plugin?.definition.hooks?.afterTurn;
      if (!hook) {
        continue;
      }
      try {
        await hook({
          ...params,
          runtime: this.context
        });
      } catch (error) {
        this.pushRuntimeError(plugin.definition.id, "afterTurn", error);
      }
    }
  }

  async runOnToolResult(params: {
    sessionId: string;
    providerId: string;
    toolName: string;
    input: unknown;
    result: {
      ok: boolean;
      output?: unknown;
      error?: {
        code?: string;
        message: string;
      };
    };
  }): Promise<void> {
    for (const plugin of this.loaded) {
      const hook = plugin.definition.hooks?.onToolResult;
      if (!hook) {
        continue;
      }
      try {
        await hook({
          ...params,
          runtime: this.context
        });
      } catch (error) {
        this.pushRuntimeError(plugin.definition.id, "onToolResult", error);
      }
    }
  }

  getStatus(): PluginRuntimeStatus {
    return {
      enabled: this.config?.enabled ?? false,
      loaded: this.loaded.map((plugin) => ({
        id: plugin.definition.id,
        modulePath: plugin.modulePath,
        hasHooks: Boolean(plugin.definition.hooks),
        tools: plugin.definition.tools?.length ?? 0,
        channels: plugin.definition.channels?.length ?? 0
      })),
      blocked: [...this.blocked],
      runtimeErrors: [...this.runtimeErrors]
    };
  }
}
