export interface ToolContext {
  workspaceDir: string;
  mutableRoots: string[];
  sessionId: string;
  providerId: string;
}

export interface ToolValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ToolValidationError {
  code: "validation_error";
  message: string;
  issues: ToolValidationIssue[];
}

export interface ToolExecutionError {
  code: "execution_error";
  message: string;
}

export type ToolFailure = ToolValidationError | ToolExecutionError;

export interface ToolParameterSchema<TInput = unknown> {
  safeParse: (
    input: unknown
  ) =>
    | {
        success: true;
        data: TInput;
      }
    | {
        success: false;
        error: unknown;
      };
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: ToolParameterSchema<unknown>;
  execute: (input: unknown, context: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolDefinitionSpec<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  parameters?: ToolParameterSchema<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput> | TOutput;
}

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: ToolFailure;
}

export interface ShellToolPolicy {
  allowCommandPrefixes?: string[];
  denyCommandPrefixes?: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface AgentToolRuntime {
  requestRestart?: (params?: {
    intent?: "manual" | "self_mod" | "config_change" | "signal";
    reason?: string;
    dryRun?: boolean;
    sessionId?: string;
    providerId?: string;
  }) => Promise<{ ok?: boolean; message?: string } | void>;
  readStatus?: () => unknown;
  listLoadedToolNames?: () => string[];
  listSessionSnapshots?: () => Array<{
    sessionId: string;
    activeProviderId: string;
    pendingProviderId?: string;
    turnInProgress: boolean;
    historyCount: number;
  }>;
  startSubagent?: (params: {
    sessionId: string;
    input: string;
    providerId?: string;
    timeoutMs?: number;
  }) => {
    ok: boolean;
    message: string;
    job?: unknown;
  };
  pollSubagent?: (jobId: string) => unknown | null;
  listSubagents?: (params?: {
    sessionId?: string;
    limit?: number;
  }) => unknown[];
  cancelSubagent?: (jobId: string) => {
    ok: boolean;
    message: string;
    job?: unknown;
  };
  readSubagentLogs?: (jobId: string, limit?: number) => unknown[];
}

export interface BuiltInToolFactoryParams {
  shellPolicy?: ShellToolPolicy;
  agent?: AgentToolRuntime;
  fetchImpl?: typeof fetch;
}

export type ToolSkipReason =
  | "import_error"
  | "invalid_shape"
  | "name_collision"
  | "duplicate_custom_name";

export interface ToolSkipDiagnostic {
  filePath: string;
  reason: ToolSkipReason;
  message: string;
  toolName?: string;
}

export interface ToolRegistryDiagnostics {
  loadedBuiltInCount: number;
  loadedCustomCount: number;
  skipped: ToolSkipDiagnostic[];
}

export interface ToolRegistryResult {
  tools: Map<string, ToolDefinition>;
  diagnostics: ToolRegistryDiagnostics;
}
