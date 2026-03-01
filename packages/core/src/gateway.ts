import http from "node:http";
import path from "node:path";
import {
  DEFAULT_AUTH_STORE_PATH,
  DEFAULT_SESSION_DIRECTORY,
  DEFAULT_TOOL_DIRECTORY
} from "./constants.js";
import type { StreamEventHandler } from "./events.js";
import type {
  GatewayConfig,
  GatewayRestartIntent,
  SessionStoreConfig,
  SkillInjectionMode
} from "./config.js";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCommandRequest,
  ChannelTurnRequest,
  ChannelTurnResult
} from "./channels.js";
import type { ChannelCommandResult } from "./channel-commands.js";
import type { AgentDefinition } from "./agent.js";
import { loadAuthStore } from "./auth/store.js";
import type { AuthStore } from "./auth/store.js";
import { ProviderManager, type ProviderRouteSelection } from "./providers/manager.js";
import type { ToolDefinition, ToolRegistryDiagnostics } from "./tools.js";
import type { ProviderProbeResult, ProviderProfile } from "./providers/types.js";
import type { ChatMessage } from "./types.js";
import type { LoadedSessionRecord, SessionMetadata, SessionOriginIdentity } from "./sessions.js";
import { SessionContinuityRuntime } from "./continuity.js";
import type { PluginRuntime } from "./plugins/runtime.js";
import type { SkillRuntime } from "./skills/runtime.js";
import type { SubagentManager } from "./subagents/manager.js";
import type { SubagentJobRecord, SubagentLogRecord } from "./subagents/types.js";
import type { OptionalModuleRuntime } from "./optional/runtime.js";
import type { ChannelSessionIdentity, ChannelSessionMappingOptions } from "./session-mapping.js";
import { normalizeMutableRoots } from "./path-policy.js";
import * as controlApi from "./gateway/control-api.js";
import * as execution from "./gateway/execution.js";
import * as orchestration from "./gateway/orchestration.js";
import * as sessionRuntime from "./gateway/session-runtime.js";
import * as sessionAdmin from "./gateway/session-admin.js";
import * as lifecycle from "./gateway/lifecycle.js";
import * as providerRouting from "./gateway/provider-routing.js";
import * as infrastructure from "./gateway/infrastructure.js";
import * as restartConfig from "./gateway/restart-config.js";
import * as runtimeCore from "./gateway/runtime-core.js";
import type {
  GatewayState,
  GatewayStatus,
  SessionSnapshot,
  ToolRunResult,
  SessionMutationResult,
  GatewayRestartRequest,
  GatewayRestartResult,
  GatewayEvolutionRunRequest,
  GatewayEvolutionRunResult,
  GatewayRuntimeEvent,
  GatewayRuntimeEventType,
  GatewayConfigReloadResult,
  GatewayEvolutionTransactionState
} from "./gateway/types.js";

export type {
  GatewayState,
  GatewayStatus,
  SessionSnapshot,
  ToolRunResult,
  SessionMutationResult,
  GatewayRestartRequest,
  GatewayRestartResultCode,
  GatewayRestartResult,
  GatewayEvolutionStep,
  GatewayEvolutionRunRequest,
  GatewayEvolutionRunResultCode,
  GatewayEvolutionRunResult,
  GatewayRuntimeEventType,
  GatewayRuntimeEvent,
  GatewayConfigReloadRejection,
  GatewayConfigReloadResult,
  GatewayEvolutionTransactionState
} from "./gateway/types.js";

const DEFAULT_RESTART_HISTORY_FILE = path.join(".drost", "restart-history.json");
const ORCHESTRATION_STATE_FILE = path.join(".drost", "orchestration-lanes.json");

type OrchestrationMode = "queue" | "interrupt" | "collect" | "steer" | "steer_backlog";
type OrchestrationDropPolicy = "old" | "new" | "summarize";

interface PendingChannelTurn {
  input: string;
  onEvent: StreamEventHandler;
  resolve: (result: ChannelTurnResult) => void;
  reject: (error: unknown) => void;
  enqueuedAt: string;
}

interface ActiveChannelTurn {
  input: string;
  onEvent: StreamEventHandler;
  resolveMany: Array<(result: ChannelTurnResult) => void>;
  rejectMany: Array<(error: unknown) => void>;
  controller: AbortController;
}

interface ChannelLaneState {
  mode: OrchestrationMode;
  cap: number;
  dropPolicy: OrchestrationDropPolicy;
  collectDebounceMs: number;
  queue: PendingChannelTurn[];
  active: ActiveChannelTurn | null;
  collectTimer: NodeJS.Timeout | null;
}

interface PersistedChannelLaneState {
  sessionId: string;
  mode: OrchestrationMode;
  cap: number;
  dropPolicy: OrchestrationDropPolicy;
  collectDebounceMs: number;
  queuedInputs: string[];
  activeInput?: string;
}

interface PersistedChannelLaneSnapshot {
  version: 1;
  updatedAt: string;
  lanes: PersistedChannelLaneState[];
}

interface RestartHistoryEntry {
  timestamp: number;
  intent: GatewayRestartIntent;
}

export class GatewayRuntime {
  private readonly config: GatewayConfig;
  private readonly exit: (code: number) => never | void;

  private state: GatewayState = "stopped";
  private startedAt: string | undefined;
  private degradedReasons: string[] = [];
  private authStorePath: string;
  private sessionDirectory: string;
  private sessionStoreEnabled: boolean;
  private authStore: AuthStore;
  private providerManager: ProviderManager | null = null;
  private providerDiagnostics: ProviderProbeResult[] = [];
  private toolRegistry: Map<string, ToolDefinition> = new Map();
  private agentDefinition: AgentDefinition | null = null;
  private agentEntryPath: string | null = null;
  private healthServer: http.Server | null = null;
  private healthUrl: string | undefined;
  private controlServer: http.Server | null = null;
  private controlUrl: string | undefined;
  private controlEventStreams = new Set<http.ServerResponse>();
  private controlMutationBuckets = new Map<string, number[]>();
  private controlEventSequence = 0;
  private restartHistoryPath: string;
  private restartHistory: RestartHistoryEntry[] = [];
  private activeEvolutionTransaction: GatewayEvolutionTransactionState | null = null;
  private runtimeEventHandlers = new Set<(event: GatewayRuntimeEvent) => void>();
  private runtimeEvents: GatewayRuntimeEvent[] = [];
  private channelAdapters = new Map<string, ChannelAdapter>();
  private channelSessionAssignments = new Map<string, string>();
  private sessionProviderRouteOverrides = new Map<string, string>();
  private channelLanes = new Map<string, ChannelLaneState>();
  private orchestrationStatePath: string;
  private suppressOrchestrationPersistence = false;
  private continuityRuntime: SessionContinuityRuntime | null = null;
  private observabilityDirectory: string;
  private observabilityWriteFailed = false;
  private pluginRuntime: PluginRuntime | null = null;
  private skillRuntime: SkillRuntime | null = null;
  private sessionSkillInjectionOverrides = new Map<string, SkillInjectionMode>();
  private subagentManager: SubagentManager | null = null;
  private optionalModuleRuntime: OptionalModuleRuntime | null = null;

  readonly workspaceDir: string;
  readonly toolDirectory: string;
  readonly mutableRoots: string[];

  constructor(params: { config: GatewayConfig; exit?: (code: number) => never | void }) {
    this.config = params.config;
    this.exit = params.exit ?? ((code) => process.exit(code));
    this.workspaceDir = path.resolve(this.config.workspaceDir);
    this.toolDirectory = path.resolve(
      this.config.toolDirectory ?? path.join(this.workspaceDir, DEFAULT_TOOL_DIRECTORY)
    );
    this.mutableRoots = normalizeMutableRoots(this.workspaceDir, this.config.evolution?.mutableRoots);
    this.authStorePath = path.resolve(
      this.config.authStorePath ?? path.join(this.workspaceDir, DEFAULT_AUTH_STORE_PATH)
    );
    this.sessionDirectory = path.resolve(
      this.config.sessionStore?.directory ?? path.join(this.workspaceDir, DEFAULT_SESSION_DIRECTORY)
    );
    this.observabilityDirectory = path.resolve(
      this.config.observability?.directory ?? path.join(this.workspaceDir, ".drost", "observability")
    );
    this.orchestrationStatePath = path.resolve(this.workspaceDir, ORCHESTRATION_STATE_FILE);
    this.agentEntryPath = this.config.agent?.entry ? path.resolve(this.config.agent.entry) : null;
    this.restartHistoryPath = path.resolve(this.workspaceDir, DEFAULT_RESTART_HISTORY_FILE);
    this.sessionStoreEnabled = this.config.sessionStore?.enabled ?? true;
    this.authStore = loadAuthStore(this.authStorePath);
    if (this.sessionStoreEnabled && this.config.sessionStore?.continuity?.enabled) {
      this.continuityRuntime = new SessionContinuityRuntime({
        config: this.config.sessionStore?.continuity,
        sessionDirectory: this.sessionDirectory,
        lockOptions: this.sessionLockOptions()
      });
    }
    for (const adapter of this.config.channels ?? []) {
      this.registerChannelAdapter(adapter);
    }
  }

  getStatus(): GatewayStatus {
    return runtimeCore.getStatus(this);
  }

  private _toolDiagnostics: ToolRegistryDiagnostics | undefined;

  onRuntimeEvent(handler: (event: GatewayRuntimeEvent) => void): () => void {
    return runtimeCore.onRuntimeEvent(this, handler);
  }

  listRuntimeEvents(limit = 100): GatewayRuntimeEvent[] {
    return runtimeCore.listRuntimeEvents(this, limit);
  }

  getActiveEvolutionTransaction(): GatewayEvolutionTransactionState | null {
    return runtimeCore.getActiveEvolutionTransaction(this);
  }

  private emitRuntimeEvent(type: GatewayRuntimeEventType, payload: Record<string, unknown>): void {
    runtimeCore.emitRuntimeEvent(this, type, payload);
  }

  private loadRestartHistory(): void {
    restartConfig.loadRestartHistory(this);
  }

  private saveRestartHistory(): void {
    restartConfig.saveRestartHistory(this);
  }

  async validateRestart(request: GatewayRestartRequest = {}): Promise<GatewayRestartResult> {
    return await restartConfig.validateRestart(this, request);
  }

  private ensureProviderManager(): ProviderManager | null {
    return providerRouting.ensureProviderManager(this);
  }

  private validateProviderRoutes(): void {
    providerRouting.validateProviderRoutes(this);
  }

  private resolveProviderRouteSelection(sessionId: string): ProviderRouteSelection | null {
    return providerRouting.resolveProviderRouteSelection(this, sessionId);
  }

  listProviderRoutes(): Array<{ id: string; primaryProviderId: string; fallbackProviderIds: string[] }> {
    return providerRouting.listProviderRoutes(this);
  }

  getSessionProviderRoute(sessionId: string): string | undefined {
    return providerRouting.getSessionProviderRoute(this, sessionId);
  }

  setSessionProviderRoute(sessionId: string, routeId: string): SessionMutationResult {
    return providerRouting.setSessionProviderRoute(this, sessionId, routeId);
  }

  private shouldPersistOrchestrationState(): boolean {
    return infrastructure.shouldPersistOrchestrationState(this);
  }

  private persistedLaneStateSnapshot(): PersistedChannelLaneSnapshot {
    return infrastructure.persistedLaneStateSnapshot(this);
  }

  private writeOrchestrationState(snapshot: PersistedChannelLaneSnapshot): void {
    infrastructure.writeOrchestrationState(this, snapshot);
  }

  private persistOrchestrationState(): void {
    infrastructure.persistOrchestrationState(this);
  }

  private restoreOrchestrationState(): void {
    infrastructure.restoreOrchestrationState(this);
  }

  private async startHealthServer(): Promise<void> {
    await infrastructure.startHealthServer(this);
  }

  private async stopHealthServer(): Promise<void> {
    await infrastructure.stopHealthServer(this);
  }

  private ensureObservabilityDirectory(): void {
    infrastructure.ensureObservabilityDirectory(this);
  }

  private appendObservabilityRecord(
    stream: "runtime-events" | "tool-traces" | "usage-events",
    payload: unknown,
    featureEnabled?: boolean
  ): void {
    infrastructure.appendObservabilityRecord(this, stream, payload, featureEnabled);
  }

  private writeControlJson(
    response: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>
  ): void {
    infrastructure.writeControlJson(this, response, statusCode, payload);
  }

  private broadcastControlRuntimeEvent(event: GatewayRuntimeEvent): void {
    controlApi.broadcastControlRuntimeEvent(this, event);
  }

  private async handleControlRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    await controlApi.handleControlRequest(this, request, response);
  }

  private async startControlServer(): Promise<void> {
    await controlApi.startControlServer(this);
  }

  private async stopControlServer(): Promise<void> {
    await controlApi.stopControlServer(this);
  }

  private sessionLockOptions(): { timeoutMs?: number; staleMs?: number } {
    return runtimeCore.sessionLockOptions(this);
  }

  private runtimeContext(): { workspaceDir: string; toolDirectory: string; mutableRoots: string[] } {
    return runtimeCore.runtimeContext(this);
  }

  private channelContext(): ChannelAdapterContext {
    return runtimeCore.channelContext(this);
  }

  private configuredSkillMode(): SkillInjectionMode {
    return runtimeCore.configuredSkillMode(this);
  }

  private skillModeForSession(sessionId: string): SkillInjectionMode {
    return runtimeCore.skillModeForSession(this, sessionId);
  }

  setSessionSkillInjectionMode(
    sessionId: string,
    mode?: SkillInjectionMode
  ): SessionMutationResult {
    return runtimeCore.setSessionSkillInjectionMode(this, sessionId, mode);
  }

  getSessionSkillInjectionMode(sessionId: string): SkillInjectionMode {
    return runtimeCore.getSessionSkillInjectionMode(this, sessionId);
  }

  private applySkillInjection(sessionId: string, input: string): {
    input: string;
    mode: SkillInjectionMode;
    skillIds: string[];
  } {
    return runtimeCore.applySkillInjection(this, sessionId, input);
  }

  private createSubagentManager(): SubagentManager | null {
    return lifecycle.createSubagentManager(this);
  }

  listSubagentJobs(params?: { sessionId?: string; limit?: number }): SubagentJobRecord[] {
    return runtimeCore.listSubagentJobs(this, params);
  }

  getSubagentJob(jobId: string): SubagentJobRecord | null {
    return runtimeCore.getSubagentJob(this, jobId);
  }

  cancelSubagentJob(jobId: string): { ok: boolean; message: string; job?: SubagentJobRecord } {
    return runtimeCore.cancelSubagentJob(this, jobId);
  }

  readSubagentLogs(jobId: string, limit = 200): SubagentLogRecord[] {
    return runtimeCore.readSubagentLogs(this, jobId, limit);
  }

  private async dispatchChannelCommandRequest(
    request: ChannelCommandRequest
  ): Promise<ChannelCommandResult> {
    return await lifecycle.dispatchChannelCommandRequest(this, request);
  }

  private scheduleSessionContinuity(fromSessionId: string, toSessionId: string): void {
    lifecycle.scheduleSessionContinuity(this, fromSessionId, toSessionId);
  }

  private async connectChannels(): Promise<void> {
    await lifecycle.connectChannels(this);
  }

  private async disconnectChannels(): Promise<void> {
    await lifecycle.disconnectChannels(this);
  }

  private async loadConfiguredAgentDefinition(): Promise<void> {
    await lifecycle.loadConfiguredAgentDefinition(this);
  }

  private buildBootToolList(): ToolDefinition[] {
    return lifecycle.buildBootToolList(this);
  }

  private persistSessionState(sessionId: string): void {
    sessionRuntime.persistSessionState(this, sessionId);
  }

  private appendSessionEvent(sessionId: string, eventType: string, payload: unknown): void {
    sessionRuntime.appendSessionEvent(this, sessionId, eventType, payload);
  }

  async start(): Promise<GatewayStatus> {
    return await lifecycle.start(this);
  }

  async stop(): Promise<void> {
    await lifecycle.stop(this);
  }

  async requestRestart(request: GatewayRestartRequest = {}): Promise<GatewayRestartResult | never | void> {
    return await restartConfig.requestRestart(this, request);
  }

  async reloadConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfigReloadResult> {
    return await restartConfig.reloadConfig(this, patch);
  }

  ensureSession(
    sessionId: string,
    options?: {
      title?: string;
      origin?: SessionOriginIdentity;
    }
  ): void {
    sessionRuntime.ensureSession(this, sessionId, options);
  }

  sessionExists(sessionId: string): boolean {
    return sessionRuntime.sessionExists(this, sessionId);
  }

  createSession(options?: {
    channel?: string;
    title?: string;
    origin?: SessionOriginIdentity;
    fromSessionId?: string;
  }): string {
    return sessionRuntime.createSession(this, options);
  }

  private channelSessionKey(
    identity: ChannelSessionIdentity,
    mapping?: ChannelSessionMappingOptions
  ): string {
    return sessionRuntime.channelSessionKey(this, identity, mapping);
  }

  createChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }): string {
    return sessionRuntime.createChannelSession(this, params);
  }

  switchChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    sessionId: string;
    title?: string;
  }): SessionMutationResult {
    return sessionRuntime.switchChannelSession(this, params);
  }

  queueSessionProviderSwitch(sessionId: string, providerId: string): void {
    sessionRuntime.queueSessionProviderSwitch(this, sessionId, providerId);
  }

  getSessionState(
    sessionId: string
  ): { activeProviderId: string; pendingProviderId?: string; metadata?: SessionMetadata } | null {
    return sessionRuntime.getSessionState(this, sessionId);
  }

  private resolveToolProviderId(sessionId: string, overrideProviderId?: string): string {
    return execution.resolveToolProviderId(this, sessionId, overrideProviderId);
  }

  private isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
    return execution.isToolAllowed(this, toolName);
  }

  async runTool(params: {
    sessionId: string;
    toolName: string;
    input: unknown;
    providerId?: string;
    onEvent?: StreamEventHandler;
  }): Promise<ToolRunResult> {
    return await execution.runTool(this, params);
  }

  async runEvolution(params: GatewayEvolutionRunRequest): Promise<GatewayEvolutionRunResult> {
    return await execution.runEvolution(this, params);
  }

  async runSessionTurn(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }): Promise<void> {
    await execution.runSessionTurn(this, params);
  }

  private resolveOrchestrationMode(): OrchestrationMode {
    return orchestration.resolveOrchestrationMode(this);
  }

  private laneForSession(sessionId: string): ChannelLaneState {
    return orchestration.laneForSession(this, sessionId);
  }

  private async runChannelTurnDirect(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }): Promise<ChannelTurnResult> {
    return await orchestration.runChannelTurnDirect(this, params);
  }

  private queueDrop(lane: ChannelLaneState): PendingChannelTurn | null {
    return orchestration.queueDrop(this, lane);
  }

  private startLaneExecution(sessionId: string, lane: ChannelLaneState): void {
    orchestration.startLaneExecution(this, sessionId, lane);
  }

  private submitChannelTurnToLane(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
  }): Promise<ChannelTurnResult> {
    return orchestration.submitChannelTurnToLane(this, params);
  }

  async runChannelTurn(params: ChannelTurnRequest): Promise<ChannelTurnResult> {
    return await orchestration.runChannelTurn(this, params);
  }

  registerChannelAdapter(adapter: ChannelAdapter): void {
    runtimeCore.registerChannelAdapter(this, adapter);
  }

  unregisterChannelAdapter(channelId: string): boolean {
    return runtimeCore.unregisterChannelAdapter(this, channelId);
  }

  listChannelAdapterIds(): string[] {
    return runtimeCore.listChannelAdapterIds(this);
  }

  listProviderProfiles(): ProviderProfile[] {
    return runtimeCore.listProviderProfiles(this);
  }

  getProviderFailoverStatus(): unknown {
    return runtimeCore.getProviderFailoverStatus(this);
  }

  async probeProviders(timeoutMs = 10_000): Promise<ProviderProbeResult[]> {
    return await runtimeCore.probeProviders(this, timeoutMs);
  }

  listSessionSnapshots(): SessionSnapshot[] {
    return sessionRuntime.listSessionSnapshots(this);
  }

  getSessionHistory(sessionId: string): ChatMessage[] {
    return sessionRuntime.getSessionHistory(this, sessionId);
  }

  deleteSession(sessionId: string): SessionMutationResult {
    return sessionAdmin.deleteSession(this, sessionId);
  }

  renameSession(params: { fromSessionId: string; toSessionId: string }): SessionMutationResult {
    return sessionAdmin.renameSession(this, params);
  }

  exportSession(sessionId: string): LoadedSessionRecord | null {
    return sessionAdmin.exportSession(this, sessionId);
  }

  importSession(params: {
    record: LoadedSessionRecord;
    overwrite?: boolean;
  }): SessionMutationResult {
    return sessionAdmin.importSession(this, params);
  }

  archiveStaleSessions(maxIdleMs?: number): string[] {
    return sessionAdmin.archiveStaleSessions(this, maxIdleMs);
  }

  private applySessionRetentionPlan(
    dryRun: boolean,
    policyOverride?: SessionStoreConfig["retention"]
  ): { archived: string[]; deleted: string[] } {
    return sessionAdmin.applySessionRetentionPlan(this, dryRun, policyOverride);
  }

  enforceSessionRetention(): { archived: string[]; deleted: string[] } {
    return sessionAdmin.enforceSessionRetention(this);
  }

  pruneSessions(params?: {
    dryRun?: boolean;
    policyOverride?: SessionStoreConfig["retention"];
  }): { archived: string[]; deleted: string[]; dryRun: boolean } {
    return sessionAdmin.pruneSessions(this, params);
  }

  getSessionRetentionStatus(): {
    enabled: boolean;
    policy?: SessionStoreConfig["retention"];
    totalSessions: number;
    totalBytes: number;
  } {
    return sessionAdmin.getSessionRetentionStatus(this);
  }

  resolveChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }): string {
    return sessionRuntime.resolveChannelSession(this, params);
  }

  listOrchestrationLaneStatuses(): Array<{
    sessionId: string;
    mode: OrchestrationMode;
    cap: number;
    dropPolicy: OrchestrationDropPolicy;
    collectDebounceMs: number;
    queued: number;
    active: boolean;
  }> {
    return orchestration.listOrchestrationLaneStatuses(this);
  }

  listLoadedToolNames(): string[] {
    return runtimeCore.listLoadedToolNames(this);
  }

  listPersistedSessionIds(): string[] {
    return sessionRuntime.listPersistedSessionIds(this);
  }

  listContinuityJobs(limit = 20): unknown[] {
    return sessionRuntime.listContinuityJobs(this, limit);
  }
}

export function createGateway(config: GatewayConfig, params?: { exit?: (code: number) => never | void }): GatewayRuntime {
  return new GatewayRuntime({
    config,
    exit: params?.exit
  });
}
