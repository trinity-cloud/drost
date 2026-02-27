import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "./tools.js";
import { importTypeScriptModule, unwrapModuleDefault } from "./module-loader.js";

function nowToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface AgentLifecycleContext {
  workspaceDir: string;
  toolDirectory: string;
  mutableRoots?: string[];
}

export interface AgentBeforeTurnResult {
  input?: string;
}

export interface AgentAfterTurnResult {
  historyCount: number;
}

export interface AgentHooks {
  onStart?: (context: AgentLifecycleContext) => Promise<void> | void;
  onStop?: (context: AgentLifecycleContext) => Promise<void> | void;
  beforeTurn?: (context: {
    sessionId: string;
    input: string;
    providerId?: string;
    runtime: AgentLifecycleContext;
  }) => Promise<AgentBeforeTurnResult | void> | AgentBeforeTurnResult | void;
  afterTurn?: (context: {
    sessionId: string;
    input: string;
    providerId?: string;
    runtime: AgentLifecycleContext;
    output: AgentAfterTurnResult;
  }) => Promise<void> | void;
}

export interface AgentDefinition {
  name?: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: AgentHooks;
}

export interface LoadedAgentDefinition {
  ok: boolean;
  agent?: AgentDefinition;
  message?: string;
}

function isToolLike(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ToolDefinition>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return false;
  }
  if (typeof candidate.execute !== "function") {
    return false;
  }
  return true;
}

function isAgentHooks(value: unknown): value is AgentHooks {
  if (!value || typeof value !== "object") {
    return false;
  }
  const hooks = value as Record<string, unknown>;
  const names: Array<keyof AgentHooks> = ["onStart", "onStop", "beforeTurn", "afterTurn"];
  for (const name of names) {
    const hook = hooks[name];
    if (hook !== undefined && typeof hook !== "function") {
      return false;
    }
  }
  return true;
}

function normalizeAgentDefinition(value: unknown): AgentDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;

  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    return null;
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") {
    return null;
  }

  const toolsRaw = candidate.tools;
  let tools: ToolDefinition[] | undefined;
  if (toolsRaw !== undefined) {
    if (!Array.isArray(toolsRaw)) {
      return null;
    }
    const parsedTools: ToolDefinition[] = [];
    for (const item of toolsRaw) {
      if (!isToolLike(item)) {
        return null;
      }
      parsedTools.push({
        name: item.name.trim(),
        description: typeof item.description === "string" ? item.description : undefined,
        parameters: item.parameters,
        execute: item.execute
      });
    }
    tools = parsedTools;
  }

  const hooksRaw = candidate.hooks;
  if (hooksRaw !== undefined && !isAgentHooks(hooksRaw)) {
    return null;
  }

  return {
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    tools,
    hooks: hooksRaw as AgentHooks | undefined
  };
}

async function importModuleWithCacheBust(filePath: string): Promise<unknown> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return await importTypeScriptModule(filePath);
  }
  const moduleUrl = pathToFileURL(filePath).href;
  return await import(`${moduleUrl}?v=${nowToken()}`);
}

export async function loadAgentDefinition(entryPath: string): Promise<LoadedAgentDefinition> {
  try {
    const loaded = await importModuleWithCacheBust(entryPath);
    const loadedRecord =
      loaded && typeof loaded === "object" ? (loaded as Record<string, unknown>) : undefined;
    const candidate = loadedRecord?.agent ?? loadedRecord?.default ?? loaded;
    const normalized = normalizeAgentDefinition(unwrapModuleDefault(candidate));
    if (!normalized) {
      return {
        ok: false,
        message:
          "Invalid agent module shape. Expected export with optional name/description, optional tools array, and optional hooks object."
      };
    }
    return {
      ok: true,
      agent: normalized
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function defineAgent<T extends AgentDefinition>(agent: T): T {
  return agent;
}
