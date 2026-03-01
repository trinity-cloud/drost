import type { ProviderAdapter, ProviderProfile } from "./providers/types.js";
import type { ShellToolPolicy, ToolDefinition } from "./tools.js";
import type { ChatMessage } from "./types.js";
import type { ChannelAdapter } from "./channels.js";
import type {
  AgentAfterTurnResult,
  AgentBeforeTurnResult,
  AgentDefinition,
  AgentLifecycleContext
} from "./agent.js";

export interface ProviderRuntimeConfig {
  profiles: ProviderProfile[];
  adapters?: ProviderAdapter[];
  defaultSessionProvider: string;
  startupProbe?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
}

export interface GatewayHooks {
  onStart?: () => Promise<void> | void;
  onRestart?: () => Promise<void> | void;
  onShutdown?: () => Promise<void> | void;
}

export type GatewayRestartIntent = "manual" | "self_mod" | "config_change" | "signal";

export interface GatewayRestartRequestContext {
  intent: GatewayRestartIntent;
  reason?: string;
  sessionId?: string;
  providerId?: string;
  dryRun: boolean;
  timestamp: string;
}

export interface GatewayRestartApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface GatewayRestartBudgetConfig {
  enabled?: boolean;
  maxRestarts?: number;
  windowMs?: number;
  intents?: GatewayRestartIntent[];
}

export interface GatewayGitCheckpointResult {
  ok: boolean;
  message: string;
}

export interface GatewayGitSafetyConfig {
  enabled?: boolean;
  strict?: boolean;
  checkpointMessage?: string;
  checkpoint?: (
    request: GatewayRestartRequestContext
  ) => Promise<GatewayGitCheckpointResult> | GatewayGitCheckpointResult;
}

export interface GatewayRestartPolicyConfig {
  requireApprovalForSelfModify?: boolean;
  approval?: (
    request: GatewayRestartRequestContext
  ) => Promise<GatewayRestartApprovalDecision> | GatewayRestartApprovalDecision;
  budget?: GatewayRestartBudgetConfig;
  gitSafety?: GatewayGitSafetyConfig;
  sandboxScope?: "tools" | "prompts" | "config" | "full";
}

export interface GatewayHealthConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  path?: string;
}

export interface SessionStoreConfig {
  enabled?: boolean;
  directory?: string;
  lock?: {
    timeoutMs?: number;
    staleMs?: number;
  };
  history?: {
    enabled?: boolean;
    maxMessages?: number;
    maxChars?: number;
    preserveSystemMessages?: boolean;
    summarize?: (params: { sessionId?: string; history: ChatMessage[] }) => ChatMessage[];
  };
  retention?: {
    enabled?: boolean;
    maxSessions?: number;
    maxTotalBytes?: number;
    maxAgeDays?: number;
    archiveFirst?: boolean;
    archiveAfterIdleMs?: number;
  };
  continuity?: {
    enabled?: boolean;
    autoOnNew?: boolean;
    sourceMaxMessages?: number;
    sourceMaxChars?: number;
    summaryMaxChars?: number;
    notifyOnComplete?: boolean;
    maxParallelJobs?: number;
  };
}

export interface GatewayShellConfig extends ShellToolPolicy {}

export interface GatewayOrchestrationConfig {
  enabled?: boolean;
  defaultMode?: "queue" | "interrupt" | "collect" | "steer" | "steer_backlog";
  defaultCap?: number;
  dropPolicy?: "old" | "new" | "summarize";
  collectDebounceMs?: number;
  persistState?: boolean;
}

export interface ProviderRouteConfig {
  id: string;
  primaryProviderId: string;
  fallbackProviderIds?: string[];
}

export interface ProviderRouterConfig {
  enabled?: boolean;
  defaultRoute?: string;
  routes?: ProviderRouteConfig[];
}

export interface GatewayFailoverConfig {
  enabled?: boolean;
  chain?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  authCooldownSeconds?: number;
  rateLimitCooldownSeconds?: number;
  serverErrorCooldownSeconds?: number;
}

export interface GatewayToolPolicyConfig {
  profile?: "strict" | "balanced" | "permissive";
  writableRoots?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface GatewayControlApiConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  readToken?: string;
  allowLoopbackWithoutAuth?: boolean;
  mutationRateLimitPerMinute?: number;
}

export interface GatewayObservabilityConfig {
  enabled?: boolean;
  directory?: string;
  toolTracesEnabled?: boolean;
  usageEventsEnabled?: boolean;
  runtimeEventsEnabled?: boolean;
}

export interface GatewayPluginsConfig {
  enabled?: boolean;
  modules?: string[];
  allowlist?: string[];
  trustedRoots?: string[];
}

export type SkillInjectionMode = "off" | "all" | "relevant";

export interface GatewaySkillsConfig {
  enabled?: boolean;
  roots?: string[];
  allow?: string[];
  deny?: string[];
  injectionMode?: SkillInjectionMode;
  maxInjected?: number;
}

export interface GatewaySubagentsConfig {
  enabled?: boolean;
  maxParallelJobs?: number;
  defaultTimeoutMs?: number;
  allowNested?: boolean;
  lockMode?: "none" | "workspace" | "exclusive";
}

export interface GatewayMemoryModuleConfig {
  enabled?: boolean;
  provider?: "filesystem" | "postgres";
  directory?: string;
  postgresUrl?: string;
  vectorEnabled?: boolean;
}

export interface GatewayGraphModuleConfig {
  enabled?: boolean;
  provider?: "filesystem" | "neo4j";
  directory?: string;
  neo4jUrl?: string;
}

export interface GatewaySchedulerModuleConfig {
  enabled?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatFile?: string;
}

export interface GatewayBackupModuleConfig {
  enabled?: boolean;
  directory?: string;
  includeObservability?: boolean;
  includeSubagents?: boolean;
}

export interface GatewayOptionalModulesConfig {
  memory?: GatewayMemoryModuleConfig;
  graph?: GatewayGraphModuleConfig;
  scheduler?: GatewaySchedulerModuleConfig;
  backup?: GatewayBackupModuleConfig;
}

export interface GatewayConfig {
  workspaceDir: string;
  toolDirectory?: string;
  builtInTools?: ToolDefinition[];
  channels?: ChannelAdapter[];
  authStorePath?: string;
  runtime?: GatewayRuntimeConfig;
  agent?: GatewayAgentConfig;
  evolution?: GatewayEvolutionConfig;
  sessionStore?: SessionStoreConfig;
  health?: GatewayHealthConfig;
  shell?: GatewayShellConfig;
  toolPolicy?: GatewayToolPolicyConfig;
  orchestration?: GatewayOrchestrationConfig;
  providerRouter?: ProviderRouterConfig;
  failover?: GatewayFailoverConfig;
  controlApi?: GatewayControlApiConfig;
  observability?: GatewayObservabilityConfig;
  plugins?: GatewayPluginsConfig;
  skills?: GatewaySkillsConfig;
  subagents?: GatewaySubagentsConfig;
  optionalModules?: GatewayOptionalModulesConfig;
  providers?: ProviderRuntimeConfig;
  restartPolicy?: GatewayRestartPolicyConfig;
  hooks?: GatewayHooks;
}

export interface GatewayAgentConfig {
  entry?: string;
}

export interface GatewayRuntimeConfig {
  entry?: string;
}

export interface GatewayEvolutionValidationConfig {
  commands?: string[];
}

export interface GatewayEvolutionHealthGateConfig {
  enabled?: boolean;
  timeoutMs?: number;
  path?: string;
}

export interface GatewayEvolutionConfig {
  enabled?: boolean;
  mutableRoots?: string[];
  validation?: GatewayEvolutionValidationConfig;
  healthGate?: GatewayEvolutionHealthGateConfig;
  rollbackOnFailure?: boolean;
  strictMode?: boolean;
}

export interface GatewayAgentHooks {
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

export type GatewayAgentDefinition = AgentDefinition;

export function defineConfig<T extends GatewayConfig>(config: T): T {
  return config;
}
