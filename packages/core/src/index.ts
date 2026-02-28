export { RESTART_EXIT_CODE } from "./constants.js";
export { createGateway, GatewayRuntime } from "./gateway.js";
export { defineConfig } from "./config.js";
export { defineAgent, loadAgentDefinition } from "./agent.js";

export type {
  GatewayConfig,
  ProviderRuntimeConfig,
  GatewayHooks,
  GatewayHealthConfig,
  SessionStoreConfig,
  GatewayShellConfig,
  GatewayRestartIntent,
  GatewayRestartRequestContext,
  GatewayRestartApprovalDecision,
  GatewayRestartBudgetConfig,
  GatewayGitCheckpointResult,
  GatewayGitSafetyConfig,
  GatewayRestartPolicyConfig,
  GatewayAgentConfig,
  GatewayRuntimeConfig,
  GatewayEvolutionValidationConfig,
  GatewayEvolutionHealthGateConfig,
  GatewayEvolutionConfig,
  GatewayAgentHooks,
  GatewayAgentDefinition
} from "./config.js";
export type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCommandRequest,
  ChannelCommandResult,
  ChannelTurnRequest,
  ChannelTurnResult
} from "./channels.js";
export { isChannelCommand } from "./channel-commands.js";
export type {
  AgentDefinition,
  AgentHooks,
  AgentLifecycleContext,
  AgentBeforeTurnResult,
  AgentAfterTurnResult,
  LoadedAgentDefinition
} from "./agent.js";
export type {
  GatewayStatus,
  GatewayState,
  SessionSnapshot,
  SessionMutationResult,
  ToolRunResult,
  GatewayRestartRequest,
  GatewayRestartResult,
  GatewayConfigReloadResult,
  GatewayRuntimeEvent,
  GatewayRuntimeEventType,
  GatewayEvolutionStep,
  GatewayEvolutionRunRequest,
  GatewayEvolutionRunResultCode,
  GatewayEvolutionRunResult,
  GatewayEvolutionTransactionState
} from "./gateway.js";

export type {
  ToolDefinition,
  ToolDefinitionSpec,
  ToolContext,
  ToolRegistryDiagnostics,
  ToolValidationIssue,
  ToolValidationError,
  ToolExecutionError,
  ToolFailure,
  ToolExecutionResult,
  ToolParameterSchema,
  ShellToolPolicy,
  AgentToolRuntime,
  BuiltInToolFactoryParams
} from "./tools.js";
export {
  defineTool,
  createDefaultBuiltInTools,
  buildToolRegistry,
  validateToolInput,
  executeToolDefinition
} from "./tools.js";

export type { NormalizedStreamEvent, NormalizedStreamEventType } from "./events.js";
export type { ChatMessage, ChatRole, UsageSnapshot, JsonValue } from "./types.js";

export type {
  ProviderAdapter,
  ProviderProfile,
  ProviderProbeResult,
  ProviderProbeContext,
  ProviderTurnRequest,
  ProviderKind,
  ProviderSessionState
} from "./providers/types.js";
export { ProviderManager } from "./providers/manager.js";
export { OpenAIResponsesAdapter } from "./providers/openai-responses.js";
export { AnthropicMessagesAdapter } from "./providers/anthropic.js";
export { CodexExecAdapter } from "./providers/codex-exec.js";

export type { AuthStore, AuthProfile, AuthCredential } from "./auth/store.js";
export {
  loadAuthStore,
  saveAuthStore,
  upsertAuthProfile,
  resolveBearerToken
} from "./auth/store.js";

export {
  resolveCodexAuthJsonPath,
  loadCodexOAuthCredential,
  type CodexOAuthCredential
} from "./auth/codex-auth.js";

export type {
  SessionOriginIdentity,
  SessionMetadata,
  LoadedSessionRecord,
  SessionIndexEntry,
  SessionLoadDiagnosticCode,
  SessionLoadDiagnostic,
  SessionLoadResult,
  SessionStoreErrorCode,
  SessionStoreLockOptions,
  SessionHistoryBudgetPolicy,
  SessionHistoryBudgetResult
} from "./sessions.js";
export {
  SessionStoreError,
  loadSessionRecord,
  loadSessionRecordWithDiagnostics,
  listSessionIndex,
  saveSessionRecord,
  deleteSessionRecord,
  renameSessionRecord,
  exportSessionRecord,
  importSessionRecord,
  archiveSessionRecord,
  applySessionHistoryBudget,
  listSessionIds
} from "./sessions.js";

export type { ChannelSessionIdentity, ChannelSessionMappingOptions } from "./session-mapping.js";
export { buildChannelSessionId, createChannelSessionOrigin } from "./session-mapping.js";
