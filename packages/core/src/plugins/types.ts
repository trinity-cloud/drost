import type { AgentLifecycleContext } from "../agent.js";
import type { ChannelAdapter } from "../channels.js";
import type { ToolDefinition } from "../tools.js";

export interface PluginBeforeTurnResult {
  input?: string;
}

export interface PluginHooks {
  beforeTurn?: (context: {
    sessionId: string;
    input: string;
    providerId?: string;
    runtime: AgentLifecycleContext;
  }) => Promise<PluginBeforeTurnResult | void> | PluginBeforeTurnResult | void;
  afterTurn?: (context: {
    sessionId: string;
    input: string;
    providerId?: string;
    runtime: AgentLifecycleContext;
    output: {
      historyCount: number;
      response?: string;
    };
  }) => Promise<void> | void;
  onToolResult?: (context: {
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
    runtime: AgentLifecycleContext;
  }) => Promise<void> | void;
}

export interface PluginDefinition {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  tools?: ToolDefinition[];
  channels?: ChannelAdapter[];
  diagnostics?: Record<string, unknown>;
  init?: (context: AgentLifecycleContext) => Promise<void> | void;
  start?: (context: AgentLifecycleContext) => Promise<void> | void;
  stop?: (context: AgentLifecycleContext) => Promise<void> | void;
  hooks?: PluginHooks;
}

export type PluginLoadBlockedReason =
  | "missing_module"
  | "untrusted_path"
  | "invalid_shape"
  | "allowlist_blocked"
  | "duplicate_id"
  | "init_failed"
  | "load_error";

export interface PluginLoadDiagnostic {
  modulePath: string;
  reason: PluginLoadBlockedReason;
  message: string;
  pluginId?: string;
}

export interface LoadedPlugin {
  modulePath: string;
  definition: PluginDefinition;
}

export interface PluginRuntimeStatus {
  enabled: boolean;
  loaded: Array<{
    id: string;
    modulePath: string;
    hasHooks: boolean;
    tools: number;
    channels: number;
  }>;
  blocked: PluginLoadDiagnostic[];
  runtimeErrors: Array<{
    pluginId: string;
    phase: "start" | "stop" | "beforeTurn" | "afterTurn" | "onToolResult";
    message: string;
  }>;
}
