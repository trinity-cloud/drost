import type { GatewayStatus, GatewayRuntimeEvent, GatewayRuntimeEventType, SessionMutationResult } from "./types.js";
import type { ToolRegistryDiagnostics } from "../tools.js";
import type { SkillInjectionMode } from "../config.js";
import type { ChannelAdapter, ChannelAdapterContext } from "../channels.js";
import type { SessionMetadata } from "../sessions.js";
import type { SubagentJobRecord, SubagentLogRecord } from "../subagents/types.js";
import type { ProviderProbeResult, ProviderProfile } from "../providers/types.js";
import { nowIso } from "./helpers.js";

export function getStatus(runtime: any): GatewayStatus {
  const activeEvolution = runtime.activeEvolutionTransaction;
  return {
    state: runtime.state,
    startedAt: runtime.startedAt,
    degradedReasons: [...runtime.degradedReasons],
    providerDiagnostics:
      runtime.providerDiagnostics.length > 0 ? [...runtime.providerDiagnostics] : undefined,
    toolDiagnostics: runtime._toolDiagnostics,
    evolution: activeEvolution
      ? {
          activeTransactionId: activeEvolution.transactionId,
          activeSince: activeEvolution.requestedAt,
          totalSteps: activeEvolution.totalSteps,
          completedSteps: activeEvolution.completedSteps
        }
      : undefined,
    agent: {
      entryPath: runtime.agentEntryPath ?? undefined,
      loaded: Boolean(runtime.agentDefinition),
      name: runtime.agentDefinition?.name,
      description: runtime.agentDefinition?.description
    },
    healthUrl: runtime.healthUrl,
    controlUrl: runtime.controlUrl,
    plugins: runtime.pluginRuntime?.getStatus(),
    skills: runtime.skillRuntime?.getStatus(),
    subagents: runtime.subagentManager?.getStatus(),
    optionalModules: runtime.optionalModuleRuntime?.listStatuses()
  };
}

export function onRuntimeEvent(runtime: any, handler: (event: GatewayRuntimeEvent) => void): () => void {
  runtime.runtimeEventHandlers.add(handler);
  return () => {
    runtime.runtimeEventHandlers.delete(handler);
  };
}

export function listRuntimeEvents(runtime: any, limit = 100): GatewayRuntimeEvent[] {
  if (limit <= 0) {
    return [];
  }
  return runtime.runtimeEvents.slice(-limit);
}

export function getActiveEvolutionTransaction(runtime: any): any {
  if (!runtime.activeEvolutionTransaction) {
    return null;
  }
  return {
    ...runtime.activeEvolutionTransaction
  };
}

export function emitRuntimeEvent(runtime: any, type: GatewayRuntimeEventType, payload: Record<string, unknown>): void {
  const event: GatewayRuntimeEvent = {
    type,
    timestamp: nowIso(),
    payload
  };
  runtime.runtimeEvents.push(event);
  if (runtime.runtimeEvents.length > 500) {
    runtime.runtimeEvents.splice(0, runtime.runtimeEvents.length - 500);
  }
  for (const handler of runtime.runtimeEventHandlers) {
    handler(event);
  }
  runtime.broadcastControlRuntimeEvent(event);
  runtime.appendObservabilityRecord("runtime-events", event, runtime.config.observability?.runtimeEventsEnabled);
}

export function sessionLockOptions(runtime: any): { timeoutMs?: number; staleMs?: number } {
  return {
    timeoutMs: runtime.config.sessionStore?.lock?.timeoutMs,
    staleMs: runtime.config.sessionStore?.lock?.staleMs
  };
}

export function runtimeContext(runtime: any): { workspaceDir: string; toolDirectory: string; mutableRoots: string[] } {
  return {
    workspaceDir: runtime.workspaceDir,
    toolDirectory: runtime.toolDirectory,
    mutableRoots: [...runtime.mutableRoots]
  };
}

export function channelContext(runtime: any): ChannelAdapterContext {
  return {
    runTurn: async (request) => await runtime.runChannelTurn(request),
    dispatchCommand: async (request) => await runtime.dispatchChannelCommandRequest(request)
  };
}

export function configuredSkillMode(runtime: any): SkillInjectionMode {
  const mode = runtime.config.skills?.injectionMode;
  if (mode === "all" || mode === "relevant") {
    return mode;
  }
  return "off";
}

export function skillModeForSession(runtime: any, sessionId: string): SkillInjectionMode {
  const override = runtime.sessionSkillInjectionOverrides.get(sessionId);
  if (override) {
    return override;
  }
  const metadataMode = runtime.getSessionState(sessionId)?.metadata?.skillInjectionMode;
  if (metadataMode === "off" || metadataMode === "all" || metadataMode === "relevant") {
    return metadataMode;
  }
  return configuredSkillMode(runtime);
}

export function setSessionSkillInjectionMode(
  runtime: any,
  sessionId: string,
  mode?: SkillInjectionMode
): SessionMutationResult {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return {
      ok: false,
      message: "sessionId is required"
    };
  }
  if (!runtime.sessionExists(normalizedSessionId)) {
    return {
      ok: false,
      message: `Unknown session: ${normalizedSessionId}`
    };
  }
  runtime.ensureSession(normalizedSessionId);
  if (mode !== undefined && mode !== "off" && mode !== "all" && mode !== "relevant") {
    return {
      ok: false,
      message: `Invalid skill injection mode: ${String(mode)}`
    };
  }

  if (mode) {
    runtime.sessionSkillInjectionOverrides.set(normalizedSessionId, mode);
  } else {
    runtime.sessionSkillInjectionOverrides.delete(normalizedSessionId);
  }

  const manager = runtime.ensureProviderManager();
  manager?.updateSessionMetadata(normalizedSessionId, {
    skillInjectionMode: mode
  });
  runtime.persistSessionState(normalizedSessionId);
  return {
    ok: true,
    message: mode
      ? `Session ${normalizedSessionId} skill injection mode set to ${mode}`
      : `Session ${normalizedSessionId} skill injection mode cleared`,
    sessionId: normalizedSessionId
  };
}

export function getSessionSkillInjectionMode(runtime: any, sessionId: string): SkillInjectionMode {
  return skillModeForSession(runtime, sessionId);
}

export function applySkillInjection(
  runtime: any,
  sessionId: string,
  input: string
): {
  input: string;
  mode: SkillInjectionMode;
  skillIds: string[];
} {
  const skillRuntime = runtime.skillRuntime;
  if (!skillRuntime) {
    return {
      input,
      mode: "off",
      skillIds: []
    };
  }
  const mode = skillModeForSession(runtime, sessionId);
  const plan = skillRuntime.buildInjectionPlan({
    input,
    mode
  });
  const skillIds = plan.selected.map((entry: { skill: { id: string } }) => entry.skill.id);
  if (!plan.text || skillIds.length === 0) {
    return {
      input,
      mode: plan.mode,
      skillIds
    };
  }
  const injectedInput = `${plan.text}\n\n[USER REQUEST]\n${input}`;
  return {
    input: injectedInput,
    mode: plan.mode,
    skillIds
  };
}

export function listSubagentJobs(runtime: any, params?: { sessionId?: string; limit?: number }): SubagentJobRecord[] {
  if (!runtime.subagentManager) {
    return [];
  }
  return runtime.subagentManager.listJobs(params);
}

export function getSubagentJob(runtime: any, jobId: string): SubagentJobRecord | null {
  return runtime.subagentManager?.getJob(jobId) ?? null;
}

export function cancelSubagentJob(runtime: any, jobId: string): { ok: boolean; message: string; job?: SubagentJobRecord } {
  if (!runtime.subagentManager) {
    return {
      ok: false,
      message: "Subagent runtime is disabled"
    };
  }
  return runtime.subagentManager.cancelJob(jobId);
}

export function readSubagentLogs(runtime: any, jobId: string, limit = 200): SubagentLogRecord[] {
  if (!runtime.subagentManager) {
    return [];
  }
  return runtime.subagentManager.readJobLogs(jobId, limit);
}

export function registerChannelAdapter(runtime: any, adapter: ChannelAdapter): void {
  const channelId = adapter.id.trim();
  if (!channelId) {
    throw new Error("Channel adapter id is required");
  }
  if (runtime.channelAdapters.has(channelId)) {
    throw new Error(`Channel adapter already registered: ${channelId}`);
  }
  runtime.channelAdapters.set(channelId, adapter);
}

export function unregisterChannelAdapter(runtime: any, channelId: string): boolean {
  return runtime.channelAdapters.delete(channelId.trim());
}

export function listChannelAdapterIds(runtime: any): string[] {
  return (Array.from(runtime.channelAdapters.keys()) as string[]).sort((left, right) => left.localeCompare(right));
}

export function listProviderProfiles(runtime: any): ProviderProfile[] {
  return runtime.config.providers ? [...runtime.config.providers.profiles] : [];
}

export function getProviderFailoverStatus(runtime: any): unknown {
  const manager = runtime.ensureProviderManager();
  return manager?.getFailoverStatus() ?? null;
}

export async function probeProviders(runtime: any, timeoutMs = 10_000): Promise<ProviderProbeResult[]> {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return [];
  }
  const diagnostics = await manager.probeAll({
    authStore: runtime.authStore,
    timeoutMs
  });
  runtime.providerDiagnostics = diagnostics;
  return diagnostics;
}

export function listLoadedToolNames(runtime: any): string[] {
  return (Array.from(runtime.toolRegistry.keys()) as string[]).sort((left, right) => left.localeCompare(right));
}
