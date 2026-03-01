import type { GatewayRestartIntent } from "../config.js";
import type { StreamEventHandler } from "../events.js";
import type { ToolRegistryDiagnostics } from "../tools.js";
import type { ProviderProbeResult } from "../providers/types.js";
import type { SessionMetadata } from "../sessions.js";
import type { PluginRuntimeStatus } from "../plugins/types.js";
import type { SkillRuntimeStatus } from "../skills/types.js";
import type { SubagentManagerStatus } from "../subagents/types.js";
import type { OptionalModuleStatus } from "../optional/runtime.js";

export type GatewayState = "stopped" | "running" | "degraded";

export interface GatewayStatus {
  state: GatewayState;
  startedAt?: string;
  degradedReasons: string[];
  toolDiagnostics?: ToolRegistryDiagnostics;
  providerDiagnostics?: ProviderProbeResult[];
  evolution?: {
    activeTransactionId?: string;
    activeSince?: string;
    totalSteps?: number;
    completedSteps?: number;
  };
  agent?: {
    entryPath?: string;
    loaded: boolean;
    name?: string;
    description?: string;
  };
  healthUrl?: string;
  controlUrl?: string;
  plugins?: PluginRuntimeStatus;
  skills?: SkillRuntimeStatus;
  subagents?: SubagentManagerStatus;
  optionalModules?: OptionalModuleStatus[];
}

export interface SessionSnapshot {
  sessionId: string;
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  historyCount: number;
  metadata: SessionMetadata;
}

export interface ToolRunResult {
  toolName: string;
  ok: boolean;
  output?: unknown;
  error?: {
    code: "tool_not_found" | "validation_error" | "execution_error" | "policy_denied";
    message: string;
    issues?: Array<{ path: string; message: string; code?: string }>;
  };
}

export interface SessionMutationResult {
  ok: boolean;
  message: string;
  sessionId?: string;
}

export interface GatewayRestartRequest {
  intent?: GatewayRestartIntent;
  reason?: string;
  sessionId?: string;
  providerId?: string;
  dryRun?: boolean;
}

export type GatewayRestartResultCode =
  | "allowed"
  | "approval_required"
  | "approval_denied"
  | "budget_exceeded"
  | "git_checkpoint_failed";

export interface GatewayRestartResult {
  ok: boolean;
  code: GatewayRestartResultCode;
  message: string;
  intent: GatewayRestartIntent;
  dryRun: boolean;
}

export interface GatewayEvolutionStep {
  toolName: string;
  input: unknown;
  providerId?: string;
}

export interface GatewayEvolutionRunRequest {
  sessionId: string;
  summary?: string;
  providerId?: string;
  steps: GatewayEvolutionStep[];
  requestRestart?: boolean;
  restartDryRun?: boolean;
  onEvent?: StreamEventHandler;
}

export type GatewayEvolutionRunResultCode = "completed" | "busy" | "failed" | "disabled" | "invalid_request";

export interface GatewayEvolutionRunResult {
  ok: boolean;
  code: GatewayEvolutionRunResultCode;
  message: string;
  transactionId?: string;
  failedStepIndex?: number;
  stepsAttempted?: number;
  activeTransactionId?: string;
  stepResults?: ToolRunResult[];
  restart?: GatewayRestartResult;
}

export type GatewayRuntimeEventType =
  | "gateway.starting"
  | "gateway.started"
  | "gateway.degraded"
  | "gateway.stopping"
  | "gateway.stopped"
  | "gateway.agent.loaded"
  | "gateway.agent.failed"
  | "gateway.restart.requested"
  | "gateway.restart.validated"
  | "gateway.restart.blocked"
  | "gateway.restart.executing"
  | "gateway.config.reloaded"
  | "evolution.requested"
  | "evolution.busy"
  | "evolution.step.completed"
  | "evolution.step.failed"
  | "evolution.completed"
  | "evolution.failed"
  | "channel.connected"
  | "channel.disconnected"
  | "channel.connection_failed"
  | "orchestration.submitted"
  | "orchestration.started"
  | "orchestration.completed"
  | "orchestration.dropped"
  | "tool.policy.denied"
  | "subagent.job.queued"
  | "subagent.job.running"
  | "subagent.job.completed"
  | "subagent.job.failed"
  | "subagent.job.cancelled"
  | "subagent.job.timed_out";

export interface GatewayRuntimeEvent {
  type: GatewayRuntimeEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface GatewayConfigReloadRejection {
  path: string;
  reason: "restart_required" | "invalid_patch";
  message: string;
}

export interface GatewayConfigReloadResult {
  ok: boolean;
  applied: string[];
  rejected: GatewayConfigReloadRejection[];
  restartRequired: boolean;
}

export interface GatewayEvolutionTransactionState {
  transactionId: string;
  requestedAt: string;
  sessionId: string;
  summary?: string;
  totalSteps: number;
  completedSteps: number;
}
