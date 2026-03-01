import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_AUTH_STORE_PATH,
  DEFAULT_SESSION_DIRECTORY,
  DEFAULT_TOOL_DIRECTORY,
  RESTART_EXIT_CODE
} from "./constants.js";
import type { StreamEventHandler } from "./events.js";
import type {
  GatewayConfig,
  GatewayRestartIntent,
  GatewayRestartRequestContext,
  GatewayGitCheckpointResult
} from "./config.js";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCommandRequest,
  ChannelTurnRequest,
  ChannelTurnResult
} from "./channels.js";
import type { ChannelCommandResult } from "./channel-commands.js";
import { dispatchChannelCommand } from "./channel-commands.js";
import type { AgentDefinition } from "./agent.js";
import { loadAgentDefinition } from "./agent.js";
import { loadAuthStore } from "./auth/store.js";
import type { AuthStore } from "./auth/store.js";
import { ProviderManager } from "./providers/manager.js";
import { AnthropicMessagesAdapter } from "./providers/anthropic.js";
import { CodexExecAdapter } from "./providers/codex-exec.js";
import { OpenAIResponsesAdapter } from "./providers/openai-responses.js";
import {
  buildToolRegistry,
  createDefaultBuiltInTools,
  executeToolDefinition,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRegistryDiagnostics
} from "./tools.js";
import type { ProviderProbeResult, ProviderProfile } from "./providers/types.js";
import type { ChatMessage } from "./types.js";
import {
  SessionStoreError,
  appendSessionEventRecord,
  applySessionHistoryBudget,
  archiveSessionRecord,
  deleteSessionRecord,
  exportSessionRecord,
  importSessionRecord,
  listSessionIds,
  listSessionIndex,
  loadSessionRecordWithDiagnostics,
  renameSessionRecord,
  saveSessionRecord,
  type LoadedSessionRecord,
  type SessionMetadata,
  type SessionOriginIdentity
} from "./sessions.js";
import { SessionContinuityRuntime } from "./continuity.js";
import {
  buildChannelSessionId,
  createChannelSessionOrigin,
  type ChannelSessionIdentity,
  type ChannelSessionMappingOptions
} from "./session-mapping.js";
import { normalizeMutableRoots } from "./path-policy.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RESTART_HISTORY_FILE = path.join(".drost", "restart-history.json");
const DEFAULT_RESTART_BUDGET_MAX = 5;
const DEFAULT_RESTART_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RESTART_BUDGET_INTENTS: ReadonlySet<GatewayRestartIntent> = new Set(["self_mod", "config_change"]);
const CONTROL_EVENT_STREAM_PING_MS = 15_000;
const CONTROL_JSON_BODY_MAX_BYTES = 512_000;
const OBS_MAX_TEXT_CHARS = 8_000;

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
    code: "tool_not_found" | "validation_error" | "execution_error";
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
  | "orchestration.dropped";

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

interface RestartHistoryEntry {
  timestamp: number;
  intent: GatewayRestartIntent;
}

type ControlAuthScope = "none" | "read" | "admin";

interface ControlAuthResult {
  ok: boolean;
  statusCode?: number;
  message?: string;
  scope: ControlAuthScope;
  mutationKey?: string;
}

export interface GatewayEvolutionTransactionState {
  transactionId: string;
  requestedAt: string;
  sessionId: string;
  summary?: string;
  totalSteps: number;
  completedSteps: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sessionStorageBytes(sessionDirectory: string, sessionId: string): number {
  const encoded = encodeURIComponent(sessionId);
  const files = [`${encoded}.jsonl`, `${encoded}.full.jsonl`];
  let total = 0;
  for (const fileName of files) {
    const filePath = path.join(sessionDirectory, fileName);
    try {
      total += fs.statSync(filePath).size;
    } catch {
      // ignore missing files
    }
  }
  return total;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function restartIntent(value: GatewayRestartRequest["intent"]): GatewayRestartIntent {
  if (value === "self_mod" || value === "config_change" || value === "signal") {
    return value;
  }
  return "manual";
}

function createEvolutionTransactionId(): string {
  return `evo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function pad3(value: number): string {
  return value.toString().padStart(3, "0");
}

function sessionTimestampToken(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  const seconds = pad2(date.getUTCSeconds());
  const millis = pad3(date.getUTCMilliseconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}`;
}

function normalizeSessionChannelPart(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return "session";
  }
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "session";
}

function readControlRequestBody(request: http.IncomingMessage, maxBytes = CONTROL_JSON_BODY_MAX_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk) => {
      if (!chunk) {
        return;
      }
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += normalized.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        request.destroy();
        return;
      }
      chunks.push(normalized);
    });
    request.on("error", reject);
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function parseBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

function clipText(value: string, maxChars = OBS_MAX_TEXT_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  const dropped = value.length - maxChars;
  return `${value.slice(0, maxChars)}...[truncated ${dropped} chars]`;
}

function summarizeForObservability(value: unknown): unknown {
  if (typeof value === "string") {
    return clipText(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(clipText(JSON.stringify(value)));
  } catch {
    return clipText(String(value));
  }
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
  private channelLanes = new Map<string, ChannelLaneState>();
  private continuityRuntime: SessionContinuityRuntime | null = null;
  private observabilityDirectory: string;
  private observabilityWriteFailed = false;

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
    const activeEvolution = this.activeEvolutionTransaction;
    return {
      state: this.state,
      startedAt: this.startedAt,
      degradedReasons: [...this.degradedReasons],
      providerDiagnostics: this.providerDiagnostics.length > 0 ? [...this.providerDiagnostics] : undefined,
      toolDiagnostics: this._toolDiagnostics,
      evolution: activeEvolution
        ? {
            activeTransactionId: activeEvolution.transactionId,
            activeSince: activeEvolution.requestedAt,
            totalSteps: activeEvolution.totalSteps,
            completedSteps: activeEvolution.completedSteps
          }
        : undefined,
      agent: {
        entryPath: this.agentEntryPath ?? undefined,
        loaded: Boolean(this.agentDefinition),
        name: this.agentDefinition?.name,
        description: this.agentDefinition?.description
      },
      healthUrl: this.healthUrl,
      controlUrl: this.controlUrl
    };
  }

  private _toolDiagnostics: ToolRegistryDiagnostics | undefined;

  onRuntimeEvent(handler: (event: GatewayRuntimeEvent) => void): () => void {
    this.runtimeEventHandlers.add(handler);
    return () => {
      this.runtimeEventHandlers.delete(handler);
    };
  }

  listRuntimeEvents(limit = 100): GatewayRuntimeEvent[] {
    if (limit <= 0) {
      return [];
    }
    return this.runtimeEvents.slice(-limit);
  }

  getActiveEvolutionTransaction(): GatewayEvolutionTransactionState | null {
    if (!this.activeEvolutionTransaction) {
      return null;
    }
    return {
      ...this.activeEvolutionTransaction
    };
  }

  private emitRuntimeEvent(type: GatewayRuntimeEventType, payload: Record<string, unknown>): void {
    const event: GatewayRuntimeEvent = {
      type,
      timestamp: nowIso(),
      payload
    };
    this.runtimeEvents.push(event);
    if (this.runtimeEvents.length > 500) {
      this.runtimeEvents.splice(0, this.runtimeEvents.length - 500);
    }
    for (const handler of this.runtimeEventHandlers) {
      handler(event);
    }
    this.broadcastControlRuntimeEvent(event);
    this.appendObservabilityRecord("runtime-events", event, this.config.observability?.runtimeEventsEnabled);
  }

  private loadRestartHistory(): void {
    try {
      const raw = fs.readFileSync(this.restartHistoryPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.restartHistory = [];
        return;
      }
      this.restartHistory = parsed
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => entry as { timestamp?: unknown; intent?: unknown })
        .filter((entry) => typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))
        .map((entry) => ({
          timestamp: entry.timestamp as number,
          intent: restartIntent(typeof entry.intent === "string" ? (entry.intent as GatewayRestartIntent) : "manual")
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.degradedReasons.push(
          `Failed to load restart history: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.restartHistory = [];
    }
  }

  private saveRestartHistory(): void {
    try {
      ensureDirectory(path.dirname(this.restartHistoryPath));
      fs.writeFileSync(this.restartHistoryPath, JSON.stringify(this.restartHistory, null, 2));
    } catch (error) {
      this.degradedReasons.push(
        `Failed to save restart history: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
  }

  private pruneRestartHistory(windowMs: number, nowMs: number): void {
    const earliest = nowMs - windowMs;
    this.restartHistory = this.restartHistory.filter((entry) => entry.timestamp >= earliest);
  }

  private resolveBudgetPolicy(): {
    enabled: boolean;
    maxRestarts: number;
    windowMs: number;
    intents: ReadonlySet<GatewayRestartIntent>;
  } {
    const budget = this.config.restartPolicy?.budget;
    const enabled = budget?.enabled ?? true;
    const maxRestarts = budget?.maxRestarts ?? DEFAULT_RESTART_BUDGET_MAX;
    const windowMs = budget?.windowMs ?? DEFAULT_RESTART_BUDGET_WINDOW_MS;
    const intents = new Set<GatewayRestartIntent>(
      budget?.intents && budget.intents.length > 0 ? budget.intents : Array.from(DEFAULT_RESTART_BUDGET_INTENTS)
    );
    return {
      enabled,
      maxRestarts,
      windowMs,
      intents
    };
  }

  private async runGitCheckpoint(request: GatewayRestartRequestContext): Promise<GatewayGitCheckpointResult> {
    const configured = this.config.restartPolicy?.gitSafety;
    if (configured?.checkpoint) {
      return await configured.checkpoint(request);
    }

    try {
      await execFileAsync("git", ["-C", this.workspaceDir, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8"
      });
    } catch {
      return {
        ok: false,
        message: "Workspace is not a git repository"
      };
    }

    if (request.dryRun) {
      return {
        ok: true,
        message: "Dry-run git checkpoint passed"
      };
    }

    try {
      await execFileAsync("git", ["-C", this.workspaceDir, "add", "-A"], {
        encoding: "utf8"
      });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    const checkpointMessage =
      configured?.checkpointMessage ??
      `drost: pre-restart checkpoint (${request.intent}) ${request.timestamp}`;
    try {
      await execFileAsync("git", ["-C", this.workspaceDir, "commit", "-m", checkpointMessage], {
        encoding: "utf8"
      });
      return {
        ok: true,
        message: "Git checkpoint commit created"
      };
    } catch (error) {
      const withStreams = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
      const detail = [toText(withStreams.stderr).trim(), toText(withStreams.stdout).trim()]
        .filter((value) => value.length > 0)
        .join(" | ");
      if (detail.toLowerCase().includes("nothing to commit")) {
        return {
          ok: true,
          message: "No changes to commit"
        };
      }
      return {
        ok: false,
        message: detail || (error instanceof Error ? error.message : String(error))
      };
    }
  }

  async validateRestart(request: GatewayRestartRequest = {}): Promise<GatewayRestartResult> {
    const now = nowIso();
    const context: GatewayRestartRequestContext = {
      intent: restartIntent(request.intent),
      reason: request.reason,
      sessionId: request.sessionId,
      providerId: request.providerId,
      dryRun: true,
      timestamp: now
    };
    return await this.evaluateRestartPolicy(context);
  }

  private async evaluateRestartPolicy(
    context: GatewayRestartRequestContext
  ): Promise<GatewayRestartResult> {
    return {
      ok: true,
      code: "allowed",
      message: context.dryRun ? "Restart validation passed (dry-run)" : "Restart approved",
      intent: context.intent,
      dryRun: context.dryRun
    };
  }

  private ensureProviderManager(): ProviderManager | null {
    if (this.providerManager) {
      return this.providerManager;
    }
    if (!this.config.providers) {
      return null;
    }
    const adapters = [
      new CodexExecAdapter(),
      new OpenAIResponsesAdapter(),
      new AnthropicMessagesAdapter(),
      ...(this.config.providers.adapters ?? [])
    ];
    this.providerManager = new ProviderManager({
      profiles: this.config.providers.profiles,
      adapters,
      failover: this.config.failover
    });
    return this.providerManager;
  }

  private async startHealthServer(): Promise<void> {
    if (this.healthServer) {
      return;
    }

    const enabled = this.config.health?.enabled ?? false;
    if (!enabled) {
      this.healthUrl = undefined;
      return;
    }

    const host = this.config.health?.host?.trim() || "127.0.0.1";
    const port = this.config.health?.port ?? 8787;
    const endpointPath = this.config.health?.path?.trim() || "/healthz";

    const server = http.createServer((request, response) => {
      const requestPath = (request.url ?? "").split("?")[0] ?? "";
      if (requestPath !== endpointPath) {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ ok: false, error: "not_found" }));
        return;
      }

      const status = this.getStatus();
      const startedAtMs = status.startedAt ? Date.parse(status.startedAt) : NaN;
      const uptimeSec =
        Number.isFinite(startedAtMs) && startedAtMs > 0
          ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
          : 0;

      response.statusCode = status.state === "degraded" ? 503 : 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          ok: status.state === "running",
          state: status.state,
          startedAt: status.startedAt,
          uptimeSec,
          degradedReasons: status.degradedReasons,
          healthUrl: this.healthUrl
        })
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (address && typeof address === "object") {
      this.healthUrl = `http://${host}:${address.port}${endpointPath}`;
    } else {
      this.healthUrl = `http://${host}:${port}${endpointPath}`;
    }
    this.healthServer = server;
  }

  private async stopHealthServer(): Promise<void> {
    const server = this.healthServer;
    this.healthServer = null;
    this.healthUrl = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private ensureObservabilityDirectory(): void {
    if (!(this.config.observability?.enabled ?? false)) {
      return;
    }
    ensureDirectory(this.observabilityDirectory);
  }

  private appendObservabilityRecord(
    stream: "runtime-events" | "tool-traces" | "usage-events",
    payload: unknown,
    featureEnabled?: boolean
  ): void {
    if (!(this.config.observability?.enabled ?? false)) {
      return;
    }
    if (featureEnabled === false) {
      return;
    }
    try {
      this.ensureObservabilityDirectory();
      const entry = {
        timestamp: nowIso(),
        stream,
        payload: summarizeForObservability(payload)
      };
      fs.appendFileSync(
        path.join(this.observabilityDirectory, `${stream}.jsonl`),
        `${JSON.stringify(entry)}\n`,
        "utf8"
      );
    } catch (error) {
      if (this.observabilityWriteFailed) {
        return;
      }
      this.observabilityWriteFailed = true;
      this.degradedReasons.push(
        `Observability write failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
  }

  private writeControlJson(
    response: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>
  ): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private controlAuthResult(
    request: http.IncomingMessage,
    isMutation: boolean
  ): ControlAuthResult {
    const allowLoopbackWithoutAuth = this.config.controlApi?.allowLoopbackWithoutAuth ?? true;
    const remoteAddress = request.socket.remoteAddress;
    if (allowLoopbackWithoutAuth && isLoopbackRemoteAddress(remoteAddress)) {
      return {
        ok: true,
        scope: "admin",
        mutationKey: `loopback:${remoteAddress ?? "unknown"}`
      };
    }

    const adminToken = this.config.controlApi?.token?.trim();
    const readToken = this.config.controlApi?.readToken?.trim();
    const bearer = parseBearerToken(
      typeof request.headers.authorization === "string"
        ? request.headers.authorization
        : Array.isArray(request.headers.authorization)
          ? request.headers.authorization[0]
          : undefined
    );
    if (!bearer) {
      return {
        ok: false,
        statusCode: 401,
        message: "Missing bearer token",
        scope: "none"
      };
    }

    let scope: ControlAuthScope = "none";
    if (adminToken && bearer === adminToken) {
      scope = "admin";
    } else if (readToken && bearer === readToken) {
      scope = "read";
    }

    if (scope === "none") {
      return {
        ok: false,
        statusCode: 401,
        message: "Invalid bearer token",
        scope: "none"
      };
    }
    if (isMutation && scope !== "admin") {
      return {
        ok: false,
        statusCode: 403,
        message: "Mutation scope requires admin token",
        scope
      };
    }
    return {
      ok: true,
      scope,
      mutationKey: `${scope}:${remoteAddress ?? "unknown"}:${bearer.slice(0, 12)}`
    };
  }

  private consumeControlMutationBudget(key: string): boolean {
    const limit = this.config.controlApi?.mutationRateLimitPerMinute ?? 60;
    if (limit <= 0) {
      return true;
    }
    const now = Date.now();
    const earliest = now - 60_000;
    const bucket = (this.controlMutationBuckets.get(key) ?? []).filter((timestamp) => timestamp >= earliest);
    if (bucket.length >= limit) {
      this.controlMutationBuckets.set(key, bucket);
      return false;
    }
    bucket.push(now);
    this.controlMutationBuckets.set(key, bucket);
    return true;
  }

  private startControlEventStream(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();

    const snapshot = {
      status: this.getStatus(),
      events: this.listRuntimeEvents(100)
    };
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    this.controlEventStreams.add(response);

    const ping = setInterval(() => {
      if (!this.controlEventStreams.has(response)) {
        clearInterval(ping);
        return;
      }
      try {
        response.write(": keepalive\n\n");
      } catch {
        this.controlEventStreams.delete(response);
        clearInterval(ping);
      }
    }, CONTROL_EVENT_STREAM_PING_MS);

    const onClose = () => {
      clearInterval(ping);
      this.controlEventStreams.delete(response);
    };
    request.on("close", onClose);
    response.on("close", onClose);
    response.on("error", onClose);
  }

  private broadcastControlRuntimeEvent(event: GatewayRuntimeEvent): void {
    if (this.controlEventStreams.size === 0) {
      return;
    }
    const sequence = ++this.controlEventSequence;
    const frame = `id: ${sequence}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of Array.from(this.controlEventStreams)) {
      try {
        stream.write(frame);
      } catch {
        this.controlEventStreams.delete(stream);
      }
    }
  }

  private async handleControlRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const basePath = "/control/v1";
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const isMutation = method !== "GET" && method !== "HEAD";
    const auth = this.controlAuthResult(request, isMutation);
    if (!auth.ok) {
      this.writeControlJson(response, auth.statusCode ?? 401, {
        ok: false,
        error: auth.message ?? "unauthorized"
      });
      return;
    }

    if (isMutation && auth.mutationKey && !this.consumeControlMutationBudget(auth.mutationKey)) {
      this.writeControlJson(response, 429, {
        ok: false,
        error: "mutation_rate_limited"
      });
      return;
    }

    if (method === "GET" && pathname === `${basePath}/events`) {
      this.startControlEventStream(request, response);
      return;
    }

    if (method === "GET" && pathname === `${basePath}/status`) {
      this.writeControlJson(response, 200, {
        ok: true,
        status: this.getStatus(),
        loadedTools: this.listLoadedToolNames(),
        sessions: this.listSessionSnapshots().length,
        channels: this.listChannelAdapterIds(),
        continuity: this.listContinuityJobs(20)
      });
      return;
    }

    if (method === "GET" && pathname === `${basePath}/sessions`) {
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(200, requestedLimit))
        : 50;
      this.writeControlJson(response, 200, {
        ok: true,
        sessions: this.listSessionSnapshots().slice(0, limit),
        total: this.listSessionSnapshots().length
      });
      return;
    }

    const sessionDetailMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)$/);
    if (method === "GET" && sessionDetailMatch) {
      const sessionId = decodeURIComponent(sessionDetailMatch[1] ?? "");
      const record = this.exportSession(sessionId);
      if (!record) {
        this.writeControlJson(response, 404, {
          ok: false,
          error: "session_not_found",
          sessionId
        });
        return;
      }
      this.writeControlJson(response, 200, {
        ok: true,
        session: record
      });
      return;
    }

    if (method === "GET" && pathname === `${basePath}/providers/status`) {
      this.writeControlJson(response, 200, {
        ok: true,
        providerProfiles: this.listProviderProfiles(),
        providerDiagnostics: this.providerDiagnostics,
        failover: this.getProviderFailoverStatus()
      });
      return;
    }

    let bodyText = "";
    let body: Record<string, unknown> = {};
    if (isMutation) {
      try {
        bodyText = await readControlRequestBody(request);
      } catch (error) {
        this.writeControlJson(response, 413, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      if (bodyText.trim().length > 0) {
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && typeof parsed === "object") {
            body = parsed as Record<string, unknown>;
          } else {
            this.writeControlJson(response, 400, {
              ok: false,
              error: "JSON body must be an object"
            });
            return;
          }
        } catch (error) {
          this.writeControlJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid JSON"
          });
          return;
        }
      }
    }

    if (method === "POST" && pathname === `${basePath}/sessions`) {
      const channel = typeof body.channel === "string" ? body.channel : undefined;
      const title = typeof body.title === "string" ? body.title : undefined;
      const fromSessionId = typeof body.fromSessionId === "string" ? body.fromSessionId : undefined;
      const sessionId = this.createSession({
        channel,
        title,
        fromSessionId
      });
      this.writeControlJson(response, 200, {
        ok: true,
        sessionId
      });
      return;
    }

    const switchMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/switch$/);
    if (method === "POST" && switchMatch) {
      const targetSessionId = decodeURIComponent(switchMatch[1] ?? "");
      const identityRaw = body.identity;
      if (!identityRaw || typeof identityRaw !== "object") {
        this.writeControlJson(response, 400, {
          ok: false,
          error: "identity object is required"
        });
        return;
      }
      const identityRecord = identityRaw as Record<string, unknown>;
      if (typeof identityRecord.channel !== "string") {
        this.writeControlJson(response, 400, {
          ok: false,
          error: "identity.channel is required"
        });
        return;
      }
      const switchResult = this.switchChannelSession({
        identity: {
          channel: identityRecord.channel,
          workspaceId:
            typeof identityRecord.workspaceId === "string" ? identityRecord.workspaceId : undefined,
          chatId: typeof identityRecord.chatId === "string" ? identityRecord.chatId : undefined,
          userId: typeof identityRecord.userId === "string" ? identityRecord.userId : undefined,
          threadId: typeof identityRecord.threadId === "string" ? identityRecord.threadId : undefined
        },
        mapping:
          body.mapping && typeof body.mapping === "object"
            ? (body.mapping as ChannelSessionMappingOptions)
            : undefined,
        sessionId: targetSessionId,
        title: typeof body.title === "string" ? body.title : undefined
      });
      this.writeControlJson(response, switchResult.ok ? 200 : 400, {
        ok: switchResult.ok,
        message: switchResult.message,
        sessionId: switchResult.sessionId
      });
      return;
    }

    if (method === "POST" && pathname === `${basePath}/chat/send`) {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      const input = typeof body.input === "string" ? body.input : "";
      if (!sessionId || !input) {
        this.writeControlJson(response, 400, {
          ok: false,
          error: "sessionId and input are required"
        });
        return;
      }
      const includeEvents = body.includeEvents === true;
      const events: unknown[] = [];
      this.ensureSession(sessionId);
      await this.runSessionTurn({
        sessionId,
        input,
        onEvent: (event) => {
          if (includeEvents) {
            events.push(event);
          }
        }
      });
      const history = this.getSessionHistory(sessionId);
      const responseText =
        history
          .filter((message) => message.role === "assistant")
          .at(-1)?.content ?? "";
      const sessionState = this.getSessionState(sessionId);
      this.writeControlJson(response, 200, {
        ok: true,
        sessionId,
        providerId: sessionState?.activeProviderId,
        response: responseText,
        events: includeEvents ? events : undefined
      });
      return;
    }

    if (method === "POST" && pathname === `${basePath}/runtime/restart`) {
      const restart = await this.requestRestart({
        intent:
          body.intent === "manual" ||
          body.intent === "self_mod" ||
          body.intent === "config_change" ||
          body.intent === "signal"
            ? body.intent
            : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        providerId: typeof body.providerId === "string" ? body.providerId : undefined,
        dryRun: body.dryRun === true
      });
      if (restart && typeof restart === "object" && "ok" in restart) {
        this.writeControlJson(response, restart.ok ? 200 : 400, {
          ok: restart.ok,
          code: restart.code,
          message: restart.message,
          intent: restart.intent,
          dryRun: restart.dryRun
        });
      } else {
        this.writeControlJson(response, 202, {
          ok: true,
          message: "restart_triggered"
        });
      }
      return;
    }

    this.writeControlJson(response, 404, {
      ok: false,
      error: "not_found"
    });
  }

  private async startControlServer(): Promise<void> {
    if (this.controlServer) {
      return;
    }

    const enabled = this.config.controlApi?.enabled ?? false;
    if (!enabled) {
      this.controlUrl = undefined;
      return;
    }

    const host = this.config.controlApi?.host?.trim() || "127.0.0.1";
    const port = this.config.controlApi?.port ?? 8788;
    const basePath = "/control/v1";

    const server = http.createServer((request, response) => {
      void this.handleControlRequest(request, response).catch((error) => {
        this.writeControlJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (address && typeof address === "object") {
      this.controlUrl = `http://${host}:${address.port}${basePath}`;
    } else {
      this.controlUrl = `http://${host}:${port}${basePath}`;
    }
    this.controlServer = server;
  }

  private async stopControlServer(): Promise<void> {
    for (const stream of this.controlEventStreams) {
      try {
        stream.end();
      } catch {
        // noop
      }
    }
    this.controlEventStreams.clear();
    this.controlMutationBuckets.clear();

    const server = this.controlServer;
    this.controlServer = null;
    this.controlUrl = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private sessionLockOptions(): { timeoutMs?: number; staleMs?: number } {
    return {
      timeoutMs: this.config.sessionStore?.lock?.timeoutMs,
      staleMs: this.config.sessionStore?.lock?.staleMs
    };
  }

  private runtimeContext(): { workspaceDir: string; toolDirectory: string; mutableRoots: string[] } {
    return {
      workspaceDir: this.workspaceDir,
      toolDirectory: this.toolDirectory,
      mutableRoots: [...this.mutableRoots]
    };
  }

  private channelContext(): ChannelAdapterContext {
    return {
      runTurn: async (request) => await this.runChannelTurn(request),
      dispatchCommand: async (request) => await this.dispatchChannelCommandRequest(request)
    };
  }

  private async dispatchChannelCommandRequest(
    request: ChannelCommandRequest
  ): Promise<ChannelCommandResult> {
    const sessionId = this.resolveChannelSession({
      identity: request.identity,
      mapping: request.mapping
    });
    const result = await dispatchChannelCommand(
      this,
      {
        sessionId,
        identity: request.identity,
        mapping: request.mapping
      },
      request.input
    );
    if (result.handled && result.action === "new_session" && result.sessionId) {
      this.scheduleSessionContinuity(sessionId, result.sessionId);
    }
    return result;
  }

  private scheduleSessionContinuity(fromSessionId: string, toSessionId: string): void {
    if (!this.sessionStoreEnabled || !this.continuityRuntime) {
      return;
    }
    const from = fromSessionId.trim();
    const to = toSessionId.trim();
    if (!from || !to || from === to) {
      return;
    }
    const job = this.continuityRuntime.schedule({
      fromSessionId: from,
      toSessionId: to
    });
    if (!job) {
      return;
    }
    this.appendSessionEvent(to, "continuity.queued", {
      jobId: job.jobId,
      fromSessionId: from,
      toSessionId: to
    });
    this.emitRuntimeEvent("gateway.degraded", {
      reason: "session_continuity_queued",
      jobId: job.jobId,
      fromSessionId: from,
      toSessionId: to
    });
  }

  private async connectChannels(): Promise<void> {
    if (this.channelAdapters.size === 0) {
      return;
    }
    const context = this.channelContext();
    for (const adapter of this.channelAdapters.values()) {
      try {
        await adapter.connect(context);
        this.emitRuntimeEvent("channel.connected", {
          channelId: adapter.id
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.degradedReasons.push(`Channel ${adapter.id} failed to connect: ${message}`);
        this.emitRuntimeEvent("channel.connection_failed", {
          channelId: adapter.id,
          message
        });
      }
    }
  }

  private async disconnectChannels(): Promise<void> {
    if (this.channelAdapters.size === 0) {
      return;
    }
    for (const adapter of this.channelAdapters.values()) {
      if (!adapter.disconnect) {
        continue;
      }
      try {
        await adapter.disconnect();
        this.emitRuntimeEvent("channel.disconnected", {
          channelId: adapter.id
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.degradedReasons.push(`Channel ${adapter.id} failed to disconnect: ${message}`);
      }
    }
  }

  private async loadConfiguredAgentDefinition(): Promise<void> {
    this.agentDefinition = null;
    if (!this.agentEntryPath) {
      return;
    }
    if (!fs.existsSync(this.agentEntryPath)) {
      const message = `Agent entry file not found: ${this.agentEntryPath}`;
      this.degradedReasons.push(message);
      this.emitRuntimeEvent("gateway.agent.failed", {
        entryPath: this.agentEntryPath,
        message
      });
      return;
    }

    const loaded = await loadAgentDefinition(this.agentEntryPath);
    if (!loaded.ok || !loaded.agent) {
      const message = `Failed to load agent entry ${this.agentEntryPath}: ${loaded.message ?? "unknown error"}`;
      this.degradedReasons.push(message);
      this.emitRuntimeEvent("gateway.agent.failed", {
        entryPath: this.agentEntryPath,
        message: loaded.message ?? "unknown error"
      });
      return;
    }

    this.agentDefinition = loaded.agent;
    this.emitRuntimeEvent("gateway.agent.loaded", {
      entryPath: this.agentEntryPath,
      name: loaded.agent.name
    });
  }

  private buildBootToolList(): ToolDefinition[] {
    const builtInTools =
      this.config.builtInTools ??
      createDefaultBuiltInTools({
        shellPolicy: this.config.shell,
        agent: {
          requestRestart: async (request) => {
            return await this.requestRestart({
              intent: restartIntent(request?.intent),
              reason: request?.reason,
              sessionId: request?.sessionId,
              providerId: request?.providerId,
              dryRun: request?.dryRun
            });
          },
          readStatus: () => this.getStatus(),
          listLoadedToolNames: () => this.listLoadedToolNames(),
          listSessionSnapshots: () => this.listSessionSnapshots()
        }
      });

    if (!this.agentDefinition?.tools || this.agentDefinition.tools.length === 0) {
      return builtInTools;
    }

    const names = new Set<string>();
    const merged: ToolDefinition[] = [];
    for (const tool of builtInTools) {
      merged.push(tool);
      names.add(tool.name);
    }

    for (const agentTool of this.agentDefinition.tools) {
      const normalizedName = agentTool.name.trim();
      if (names.has(normalizedName)) {
        this.degradedReasons.push(
          `Agent tool "${normalizedName}" collides with existing tool name and was skipped`
        );
        continue;
      }
      names.add(normalizedName);
      merged.push(agentTool);
    }

    return merged;
  }

  private applySessionHistoryBudget(sessionId: string, history: ChatMessage[]): ChatMessage[] {
    const policy = this.config.sessionStore?.history;
    const trimmed = applySessionHistoryBudget({
      sessionId,
      history,
      policy
    });
    if (trimmed.trimmed) {
      this.emitRuntimeEvent("gateway.degraded", {
        reason: "session_history_trimmed",
        sessionId,
        droppedMessages: trimmed.droppedMessages,
        droppedCharacters: trimmed.droppedCharacters
      });
    }
    return trimmed.history;
  }

  private restoreSessionState(sessionId: string): void {
    if (!this.sessionStoreEnabled) {
      return;
    }
    const manager = this.ensureProviderManager();
    if (!manager) {
      return;
    }
    const loaded = loadSessionRecordWithDiagnostics(this.sessionDirectory, sessionId);
    if (loaded.diagnostics && loaded.diagnostics.length > 0) {
      for (const diagnostic of loaded.diagnostics) {
        this.degradedReasons.push(
          `Session ${sessionId} ${diagnostic.code}: ${diagnostic.message}${diagnostic.quarantinedPath ? ` (${diagnostic.quarantinedPath})` : ""}`
        );
      }
      this.state = "degraded";
    }
    if (!loaded.record) {
      return;
    }

    manager.hydrateSession({
      sessionId,
      history: loaded.record.history,
      activeProviderId: loaded.record.activeProviderId,
      pendingProviderId: loaded.record.pendingProviderId,
      metadata: loaded.record.metadata
    });
  }

  private persistSessionState(sessionId: string): void {
    if (!this.sessionStoreEnabled) {
      return;
    }
    const manager = this.ensureProviderManager();
    if (!manager) {
      return;
    }
    const session = manager.getSession(sessionId);
    if (!session) {
      return;
    }

    session.history = this.applySessionHistoryBudget(sessionId, session.history);
    session.metadata.lastActivityAt = nowIso();

    saveSessionRecord({
      sessionDirectory: this.sessionDirectory,
      sessionId,
      activeProviderId: session.activeProviderId,
      pendingProviderId: session.pendingProviderId,
      history: session.history,
      metadata: session.metadata,
      lock: this.sessionLockOptions()
    });
    try {
      this.enforceSessionRetention();
    } catch (error) {
      this.degradedReasons.push(
        `Session retention enforcement failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
  }

  private appendSessionEvent(sessionId: string, eventType: string, payload: unknown): void {
    if (!this.sessionStoreEnabled) {
      return;
    }
    try {
      appendSessionEventRecord({
        sessionDirectory: this.sessionDirectory,
        sessionId,
        eventType,
        payload,
        timestamp: nowIso(),
        lock: this.sessionLockOptions()
      });
    } catch (error) {
      this.degradedReasons.push(
        `Failed to append session event for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
  }

  async start(): Promise<GatewayStatus> {
    if (this.state === "running" || this.state === "degraded") {
      return this.getStatus();
    }

    this.emitRuntimeEvent("gateway.starting", {
      workspaceDir: this.workspaceDir,
      toolDirectory: this.toolDirectory,
      agentEntryPath: this.agentEntryPath
    });

    ensureDirectory(this.workspaceDir);
    ensureDirectory(this.toolDirectory);
    ensureDirectory(path.dirname(this.restartHistoryPath));
    if (this.sessionStoreEnabled) {
      ensureDirectory(this.sessionDirectory);
    }
    this.ensureObservabilityDirectory();
    this.loadRestartHistory();

    this.degradedReasons = [];
    this.providerDiagnostics = [];
    await this.loadConfiguredAgentDefinition();

    const toolRegistryResult = await buildToolRegistry({
      builtInTools: this.buildBootToolList(),
      customToolsDirectory: this.toolDirectory
    });

    this._toolDiagnostics = toolRegistryResult.diagnostics;
    this.toolRegistry = toolRegistryResult.tools;
    if (toolRegistryResult.diagnostics.skipped.length > 0) {
      this.degradedReasons.push(
        `Skipped ${toolRegistryResult.diagnostics.skipped.length} invalid or conflicting custom tool(s)`
      );
    }

    if (this.config.providers) {
      this.ensureProviderManager();
      const probeEnabled = this.config.providers.startupProbe?.enabled ?? true;
      if (probeEnabled && this.providerManager) {
        const timeoutMs = this.config.providers.startupProbe?.timeoutMs ?? 10_000;
        this.providerDiagnostics = await this.providerManager.probeAll({
          authStore: this.authStore,
          timeoutMs
        });
        const failed = this.providerDiagnostics.filter((entry) => !entry.ok);
        if (failed.length > 0) {
          this.degradedReasons.push(
            `${failed.length} provider profile(s) failed startup capability probe`
          );
        }
      }
    }

    try {
      await this.startHealthServer();
    } catch (error) {
      this.degradedReasons.push(
        `Health endpoint failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      await this.startControlServer();
    } catch (error) {
      this.degradedReasons.push(
        `Control API failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (this.agentDefinition?.hooks?.onStart) {
      try {
        await this.agentDefinition.hooks.onStart(this.runtimeContext());
      } catch (error) {
        this.degradedReasons.push(
          `Agent onStart hook failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await this.connectChannels();

    await this.config.hooks?.onStart?.();

    this.startedAt = nowIso();
    this.state = this.degradedReasons.length > 0 ? "degraded" : "running";
    this.emitRuntimeEvent("gateway.started", {
      state: this.state,
      startedAt: this.startedAt,
      healthUrl: this.healthUrl,
      controlUrl: this.controlUrl
    });
    if (this.degradedReasons.length > 0) {
      this.emitRuntimeEvent("gateway.degraded", {
        reasons: [...this.degradedReasons]
      });
    }
    try {
      this.enforceSessionRetention();
    } catch (error) {
      this.degradedReasons.push(
        `Session retention enforcement failed at startup: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.emitRuntimeEvent("gateway.stopping", {
      state: this.state
    });
    await this.stopControlServer();
    await this.stopHealthServer();
    for (const lane of this.channelLanes.values()) {
      if (lane.collectTimer) {
        clearTimeout(lane.collectTimer);
        lane.collectTimer = null;
      }
      lane.active?.controller.abort();
      lane.active = null;
      for (const queued of lane.queue.splice(0)) {
        queued.reject(new Error("Gateway is stopping"));
      }
    }
    this.channelLanes.clear();
    await this.disconnectChannels();
    if (this.agentDefinition?.hooks?.onStop) {
      try {
        await this.agentDefinition.hooks.onStop(this.runtimeContext());
      } catch (error) {
        this.degradedReasons.push(
          `Agent onStop hook failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    await this.config.hooks?.onShutdown?.();
    this.state = "stopped";
    this.emitRuntimeEvent("gateway.stopped", {
      state: this.state
    });
  }

  async requestRestart(request: GatewayRestartRequest = {}): Promise<GatewayRestartResult | never | void> {
    const context: GatewayRestartRequestContext = {
      intent: restartIntent(request.intent),
      reason: request.reason,
      sessionId: request.sessionId,
      providerId: request.providerId,
      dryRun: request.dryRun ?? false,
      timestamp: nowIso()
    };

    this.emitRuntimeEvent("gateway.restart.requested", {
      intent: context.intent,
      reason: context.reason,
      sessionId: context.sessionId,
      providerId: context.providerId,
      dryRun: context.dryRun
    });

    const decision = await this.evaluateRestartPolicy(context);
    if (!decision.ok) {
      this.emitRuntimeEvent("gateway.restart.blocked", {
        intent: context.intent,
        code: decision.code,
        message: decision.message,
        dryRun: context.dryRun
      });
      return decision;
    }

    this.emitRuntimeEvent("gateway.restart.validated", {
      intent: context.intent,
      dryRun: context.dryRun
    });

    if (context.dryRun) {
      return decision;
    }

    await this.config.hooks?.onRestart?.();

    this.restartHistory.push({
      timestamp: Date.now(),
      intent: context.intent
    });
    this.saveRestartHistory();

    this.emitRuntimeEvent("gateway.restart.executing", {
      intent: context.intent,
      reason: context.reason
    });

    await this.stop();
    return this.exit(RESTART_EXIT_CODE);
  }

  async reloadConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfigReloadResult> {
    const applied: string[] = [];
    const rejected: GatewayConfigReloadRejection[] = [];

    if (patch.workspaceDir !== undefined && patch.workspaceDir !== this.config.workspaceDir) {
      rejected.push({
        path: "workspaceDir",
        reason: "restart_required",
        message: "workspaceDir requires restart and full gateway re-bootstrap"
      });
    }
    if (patch.toolDirectory !== undefined && patch.toolDirectory !== this.config.toolDirectory) {
      rejected.push({
        path: "toolDirectory",
        reason: "restart_required",
        message: "toolDirectory requires restart to rebuild tool registry"
      });
    }
    if (patch.authStorePath !== undefined && patch.authStorePath !== this.config.authStorePath) {
      rejected.push({
        path: "authStorePath",
        reason: "restart_required",
        message: "authStorePath requires restart to safely reload auth context"
      });
    }
    if (patch.builtInTools !== undefined) {
      rejected.push({
        path: "builtInTools",
        reason: "restart_required",
        message: "builtInTools cannot be hot-reloaded"
      });
    }
    if (patch.shell !== undefined) {
      rejected.push({
        path: "shell",
        reason: "restart_required",
        message: "shell policy currently requires restart"
      });
    }
    if (patch.sessionStore !== undefined) {
      rejected.push({
        path: "sessionStore",
        reason: "restart_required",
        message: "sessionStore configuration requires restart"
      });
    }
    if (patch.providers && (patch.providers.profiles || patch.providers.defaultSessionProvider || patch.providers.adapters)) {
      rejected.push({
        path: "providers.profiles/defaultSessionProvider/adapters",
        reason: "restart_required",
        message: "provider topology changes require restart"
      });
    }
    if (patch.hooks !== undefined) {
      rejected.push({
        path: "hooks",
        reason: "restart_required",
        message: "hook updates require restart"
      });
    }
    if (patch.agent !== undefined) {
      rejected.push({
        path: "agent",
        reason: "restart_required",
        message: "agent entry configuration requires restart"
      });
    }
    if (patch.runtime !== undefined) {
      rejected.push({
        path: "runtime",
        reason: "restart_required",
        message: "runtime entry configuration requires restart"
      });
    }
    if (patch.evolution !== undefined) {
      rejected.push({
        path: "evolution",
        reason: "restart_required",
        message: "evolution policy configuration requires restart"
      });
    }

    if (patch.health) {
      this.config.health = {
        ...(this.config.health ?? {}),
        ...patch.health
      };
      applied.push("health");
      if (this.state === "running" || this.state === "degraded") {
        await this.stopHealthServer();
        try {
          await this.startHealthServer();
        } catch (error) {
          this.degradedReasons.push(
            `Health endpoint failed to start during reload: ${error instanceof Error ? error.message : String(error)}`
          );
          this.state = "degraded";
        }
      }
    }

    if (patch.controlApi) {
      this.config.controlApi = {
        ...(this.config.controlApi ?? {}),
        ...patch.controlApi
      };
      applied.push("controlApi");
      if (this.state === "running" || this.state === "degraded") {
        await this.stopControlServer();
        try {
          await this.startControlServer();
        } catch (error) {
          this.degradedReasons.push(
            `Control API failed to start during reload: ${error instanceof Error ? error.message : String(error)}`
          );
          this.state = "degraded";
        }
      }
    }

    if (patch.observability) {
      this.config.observability = {
        ...(this.config.observability ?? {}),
        ...patch.observability
      };
      if (patch.observability.directory !== undefined) {
        this.observabilityDirectory = path.resolve(patch.observability.directory);
      }
      this.observabilityWriteFailed = false;
      this.ensureObservabilityDirectory();
      applied.push("observability");
    }

    if (patch.providers?.startupProbe) {
      const currentProviders = this.config.providers;
      if (!currentProviders) {
        rejected.push({
          path: "providers.startupProbe",
          reason: "invalid_patch",
          message: "providers.startupProbe cannot be reloaded when providers are not configured"
        });
      } else {
        currentProviders.startupProbe = {
          ...(currentProviders.startupProbe ?? {}),
          ...patch.providers.startupProbe
        };
        applied.push("providers.startupProbe");
      }
    }

    if (patch.restartPolicy) {
      this.config.restartPolicy = {
        ...(this.config.restartPolicy ?? {}),
        ...patch.restartPolicy
      };
      applied.push("restartPolicy");
    }

    const restartRequired = rejected.some((entry) => entry.reason === "restart_required");
    const result: GatewayConfigReloadResult = {
      ok: rejected.length === 0,
      applied,
      rejected,
      restartRequired
    };
    this.emitRuntimeEvent("gateway.config.reloaded", {
      ok: result.ok,
      applied,
      rejected,
      restartRequired
    });
    return result;
  }

  ensureSession(
    sessionId: string,
    options?: {
      title?: string;
      origin?: SessionOriginIdentity;
    }
  ): void {
    if (!this.config.providers) {
      throw new Error("No provider manager configured");
    }
    const manager = this.ensureProviderManager();
    if (!manager) {
      throw new Error("No provider manager configured");
    }
    manager.ensureSession(sessionId, this.config.providers.defaultSessionProvider, {
      title: options?.title,
      origin: options?.origin,
      lastActivityAt: nowIso()
    });
    try {
      this.restoreSessionState(sessionId);
    } catch (error) {
      this.degradedReasons.push(
        `Failed to restore session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      this.state = "degraded";
    }
    this.persistSessionState(sessionId);
  }

  sessionExists(sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return false;
    }
    const manager = this.ensureProviderManager();
    if (manager?.getSession(normalizedSessionId)) {
      return true;
    }
    if (!this.sessionStoreEnabled) {
      return false;
    }
    return listSessionIds(this.sessionDirectory).includes(normalizedSessionId);
  }

  createSession(options?: {
    channel?: string;
    title?: string;
    origin?: SessionOriginIdentity;
    fromSessionId?: string;
  }): string {
    const channelPart = normalizeSessionChannelPart(options?.origin?.channel ?? options?.channel);
    const timestamp = sessionTimestampToken();

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const sessionId =
        attempt === 0
          ? `${channelPart}-${timestamp}`
          : `${channelPart}-${timestamp}-${attempt + 1}`;
      if (this.sessionExists(sessionId)) {
        continue;
      }
      this.ensureSession(sessionId, {
        title: options?.title,
        origin: options?.origin
      });
      const fromSessionId = options?.fromSessionId?.trim();
      if (fromSessionId && fromSessionId !== sessionId && this.sessionExists(fromSessionId)) {
        this.scheduleSessionContinuity(fromSessionId, sessionId);
      }
      return sessionId;
    }

    throw new Error("Failed to allocate a unique session id");
  }

  private channelSessionKey(
    identity: ChannelSessionIdentity,
    mapping?: ChannelSessionMappingOptions
  ): string {
    return buildChannelSessionId(identity, mapping);
  }

  createChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }): string {
    const channelKey = this.channelSessionKey(params.identity, params.mapping);
    const previousSessionId = this.channelSessionAssignments.get(channelKey) ?? channelKey;
    const sessionId = this.createSession({
      channel: params.identity.channel,
      title: params.title,
      origin: createChannelSessionOrigin(params.identity),
      fromSessionId: this.sessionExists(previousSessionId) ? previousSessionId : undefined
    });
    this.channelSessionAssignments.set(channelKey, sessionId);
    return sessionId;
  }

  switchChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    sessionId: string;
    title?: string;
  }): SessionMutationResult {
    const targetSessionId = params.sessionId.trim();
    if (!targetSessionId) {
      return {
        ok: false,
        message: "Session id is required"
      };
    }
    if (!this.sessionExists(targetSessionId)) {
      return {
        ok: false,
        message: `Unknown session: ${targetSessionId}`
      };
    }

    this.ensureSession(targetSessionId, {
      title: params.title,
      origin: createChannelSessionOrigin(params.identity)
    });
    this.channelSessionAssignments.set(this.channelSessionKey(params.identity, params.mapping), targetSessionId);
    return {
      ok: true,
      message: `Active session switched to ${targetSessionId}`,
      sessionId: targetSessionId
    };
  }

  queueSessionProviderSwitch(sessionId: string, providerId: string): void {
    const manager = this.ensureProviderManager();
    if (!manager) {
      throw new Error("No provider manager configured");
    }
    manager.queueProviderSwitch(sessionId, providerId);
    this.persistSessionState(sessionId);
  }

  getSessionState(sessionId: string): { activeProviderId: string; pendingProviderId?: string } | null {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return null;
    }
    const session = manager.getSession(sessionId);
    if (!session) {
      return null;
    }
    return {
      activeProviderId: session.activeProviderId,
      pendingProviderId: session.pendingProviderId
    };
  }

  private resolveToolProviderId(sessionId: string, overrideProviderId?: string): string {
    if (overrideProviderId && overrideProviderId.trim().length > 0) {
      return overrideProviderId;
    }
    const manager = this.ensureProviderManager();
    if (!manager) {
      return "local";
    }
    const session = manager.getSession(sessionId);
    if (!session) {
      return "local";
    }
    return session.activeProviderId;
  }

  async runTool(params: {
    sessionId: string;
    toolName: string;
    input: unknown;
    providerId?: string;
    onEvent?: StreamEventHandler;
  }): Promise<ToolRunResult> {
    const toolName = params.toolName.trim();
    if (!toolName) {
      return {
        toolName,
        ok: false,
        error: {
          code: "tool_not_found",
          message: "Tool name is required"
        }
      };
    }

    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      return {
        toolName,
        ok: false,
        error: {
          code: "tool_not_found",
          message: `Unknown tool: ${toolName}`
        }
      };
    }

    const providerId = this.resolveToolProviderId(params.sessionId, params.providerId);
    const timestamp = nowIso();
    params.onEvent?.({
      type: "tool.call.started",
      sessionId: params.sessionId,
      providerId,
      timestamp,
      payload: {
        toolName,
        metadata: {
          input: safeJsonStringify(params.input)
        }
      }
    });
    this.appendSessionEvent(params.sessionId, "tool.call.started", {
      providerId,
      toolName,
      input: params.input
    });
    this.appendObservabilityRecord(
      "tool-traces",
      {
        phase: "started",
        sessionId: params.sessionId,
        providerId,
        toolName,
        input: params.input
      },
      this.config.observability?.toolTracesEnabled
    );

    const startedAt = Date.now();
    const result: ToolExecutionResult = await executeToolDefinition({
      tool,
      input: params.input,
      context: {
        workspaceDir: this.workspaceDir,
        mutableRoots: this.mutableRoots,
        sessionId: params.sessionId,
        providerId
      }
    });

    if (!result.ok) {
      const completedAt = nowIso();
      params.onEvent?.({
        type: "tool.call.completed",
        sessionId: params.sessionId,
        providerId,
        timestamp: completedAt,
        payload: {
          toolName,
          error: result.error?.message,
          metadata: {
            ok: false,
            code: result.error?.code ?? "execution_error",
            durationMs: Date.now() - startedAt
          }
        }
      });
      this.appendSessionEvent(params.sessionId, "tool.call.completed", {
        providerId,
        toolName,
        ok: false,
        code: result.error?.code ?? "execution_error",
        message: result.error?.message ?? "Tool execution failed",
        durationMs: Date.now() - startedAt
      });
      this.appendObservabilityRecord(
        "tool-traces",
        {
          phase: "completed",
          sessionId: params.sessionId,
          providerId,
          toolName,
          ok: false,
          code: result.error?.code ?? "execution_error",
          message: result.error?.message ?? "Tool execution failed",
          durationMs: Date.now() - startedAt
        },
        this.config.observability?.toolTracesEnabled
      );

      if (result.error?.code === "validation_error") {
        return {
          toolName,
          ok: false,
          error: {
            code: "validation_error",
            message: result.error.message,
            issues: result.error.issues
          }
        };
      }

      return {
        toolName,
        ok: false,
        error: {
          code: "execution_error",
          message: result.error?.message ?? "Tool execution failed"
        }
      };
    }

    const completedAt = nowIso();
    params.onEvent?.({
      type: "tool.call.completed",
      sessionId: params.sessionId,
      providerId,
      timestamp: completedAt,
      payload: {
        toolName,
        metadata: {
          ok: true,
          durationMs: Date.now() - startedAt,
          output: safeJsonStringify(result.output)
        }
      }
    });
    this.appendSessionEvent(params.sessionId, "tool.call.completed", {
      providerId,
      toolName,
      ok: true,
      output: result.output,
      durationMs: Date.now() - startedAt
    });
    this.appendObservabilityRecord(
      "tool-traces",
      {
        phase: "completed",
        sessionId: params.sessionId,
        providerId,
        toolName,
        ok: true,
        output: result.output,
        durationMs: Date.now() - startedAt
      },
      this.config.observability?.toolTracesEnabled
    );

    return {
      toolName,
      ok: true,
      output: result.output
    };
  }

  async runEvolution(params: GatewayEvolutionRunRequest): Promise<GatewayEvolutionRunResult> {
    const evolutionEnabled = this.config.evolution?.enabled ?? true;
    if (!evolutionEnabled) {
      return {
        ok: false,
        code: "disabled",
        message: "Evolution is disabled by configuration"
      };
    }

    const sessionId = params.sessionId.trim();
    if (!sessionId) {
      return {
        ok: false,
        code: "invalid_request",
        message: "sessionId is required"
      };
    }

    if (!Array.isArray(params.steps) || params.steps.length === 0) {
      return {
        ok: false,
        code: "invalid_request",
        message: "At least one evolution step is required"
      };
    }

    const active = this.activeEvolutionTransaction;
    if (active) {
      this.emitRuntimeEvent("evolution.busy", {
        activeTransactionId: active.transactionId,
        requestedSessionId: sessionId
      });
      return {
        ok: false,
        code: "busy",
        message: `Evolution transaction already running: ${active.transactionId}`,
        activeTransactionId: active.transactionId
      };
    }

    const transaction: GatewayEvolutionTransactionState = {
      transactionId: createEvolutionTransactionId(),
      requestedAt: nowIso(),
      sessionId,
      summary: params.summary?.trim() || undefined,
      totalSteps: params.steps.length,
      completedSteps: 0
    };
    this.activeEvolutionTransaction = transaction;
    this.emitRuntimeEvent("evolution.requested", {
      transactionId: transaction.transactionId,
      sessionId,
      summary: transaction.summary,
      totalSteps: transaction.totalSteps
    });

    const stepResults: ToolRunResult[] = [];
    try {
      for (let index = 0; index < params.steps.length; index += 1) {
        const step = params.steps[index];
        if (!step) {
          this.emitRuntimeEvent("evolution.step.failed", {
            transactionId: transaction.transactionId,
            stepIndex: index,
            reason: "missing_step_payload"
          });
          return {
            ok: false,
            code: "failed",
            message: `Evolution step ${index + 1} payload is missing`,
            transactionId: transaction.transactionId,
            failedStepIndex: index,
            stepsAttempted: stepResults.length,
            stepResults
          };
        }
        const toolName = step.toolName.trim();
        if (!toolName) {
          this.emitRuntimeEvent("evolution.step.failed", {
            transactionId: transaction.transactionId,
            stepIndex: index,
            reason: "missing_tool_name"
          });
          return {
            ok: false,
            code: "failed",
            message: `Evolution step ${index + 1} is missing toolName`,
            transactionId: transaction.transactionId,
            failedStepIndex: index,
            stepsAttempted: stepResults.length,
            stepResults
          };
        }

        const toolResult = await this.runTool({
          sessionId,
          toolName,
          input: step.input,
          providerId: step.providerId ?? params.providerId,
          onEvent: params.onEvent
        });
        stepResults.push(toolResult);
        if (!toolResult.ok) {
          this.emitRuntimeEvent("evolution.step.failed", {
            transactionId: transaction.transactionId,
            stepIndex: index,
            toolName,
            message: toolResult.error?.message ?? "unknown tool failure"
          });
          this.emitRuntimeEvent("evolution.failed", {
            transactionId: transaction.transactionId,
            failedStepIndex: index
          });
          return {
            ok: false,
            code: "failed",
            message: `Evolution step ${index + 1} failed: ${toolResult.error?.message ?? "unknown tool failure"}`,
            transactionId: transaction.transactionId,
            failedStepIndex: index,
            stepsAttempted: stepResults.length,
            stepResults
          };
        }

        transaction.completedSteps = index + 1;
        this.emitRuntimeEvent("evolution.step.completed", {
          transactionId: transaction.transactionId,
          stepIndex: index,
          toolName
        });
      }

      let restartResult: GatewayRestartResult | undefined;
      if (params.requestRestart) {
        const restartResponse = await this.requestRestart({
          intent: "self_mod",
          reason: transaction.summary ?? `evolution transaction ${transaction.transactionId}`,
          sessionId,
          providerId: params.providerId,
          dryRun: params.restartDryRun ?? false
        });
        if (restartResponse && typeof restartResponse === "object" && "ok" in restartResponse) {
          restartResult = restartResponse;
          if (!restartResult.ok) {
            this.emitRuntimeEvent("evolution.failed", {
              transactionId: transaction.transactionId,
              failedStepIndex: stepResults.length - 1,
              restartCode: restartResult.code
            });
            return {
              ok: false,
              code: "failed",
              message: `Evolution restart blocked: ${restartResult.message}`,
              transactionId: transaction.transactionId,
              failedStepIndex: stepResults.length - 1,
              stepsAttempted: stepResults.length,
              stepResults,
              restart: restartResult
            };
          }
        }
      }

      this.emitRuntimeEvent("evolution.completed", {
        transactionId: transaction.transactionId,
        stepsCompleted: transaction.completedSteps,
        restartRequested: Boolean(params.requestRestart),
        restartDryRun: params.restartDryRun ?? false
      });
      return {
        ok: true,
        code: "completed",
        message: "Evolution transaction completed",
        transactionId: transaction.transactionId,
        stepsAttempted: stepResults.length,
        stepResults,
        restart: restartResult
      };
    } finally {
      this.activeEvolutionTransaction = null;
    }
  }

  async runSessionTurn(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }): Promise<void> {
    const manager = this.ensureProviderManager();
    if (!manager) {
      throw new Error("No provider manager configured");
    }
    const turnStartedAtMs = Date.now();
    const historyBeforeCount = manager.getSessionHistory(params.sessionId).length;
    const session = manager.getSession(params.sessionId);
    const activeProviderId = session?.activeProviderId;
    let input = params.input;
    if (this.agentDefinition?.hooks?.beforeTurn) {
      const hookResult = await this.agentDefinition.hooks.beforeTurn({
        sessionId: params.sessionId,
        input,
        providerId: activeProviderId,
        runtime: this.runtimeContext()
      });
      if (hookResult && typeof hookResult.input === "string") {
        input = hookResult.input;
      }
    }

    let runSucceeded = false;
    const onEvent: StreamEventHandler = (event) => {
      if (event.type !== "tool.call.started" && event.type !== "tool.call.completed") {
        this.appendSessionEvent(params.sessionId, event.type, {
          providerId: event.providerId,
          payload: event.payload
        });
      }
      params.onEvent(event);
    };
    try {
      await manager.runTurn({
        sessionId: params.sessionId,
        input,
        authStore: this.authStore,
        onEvent,
        signal: params.signal,
        availableToolNames: this.listLoadedToolNames(),
        runTool: async (request) =>
          this.runTool({
            sessionId: request.sessionId,
            toolName: request.toolName,
            input: request.input,
            providerId: request.providerId,
            onEvent: request.onEvent
          })
      });
      runSucceeded = true;
    } finally {
      if (runSucceeded) {
        const history = manager.getSessionHistory(params.sessionId);
        const assistantText = history
          .filter((message) => message.role === "assistant")
          .at(-1)?.content;
        this.appendObservabilityRecord(
          "usage-events",
          {
            kind: "session.turn",
            sessionId: params.sessionId,
            providerId: this.getSessionState(params.sessionId)?.activeProviderId ?? activeProviderId ?? "unknown",
            durationMs: Date.now() - turnStartedAtMs,
            inputChars: input.length,
            outputChars: assistantText ? assistantText.length : 0,
            historyBeforeCount,
            historyAfterCount: history.length
          },
          this.config.observability?.usageEventsEnabled
        );
      }
      if (runSucceeded && this.agentDefinition?.hooks?.afterTurn) {
        try {
          await this.agentDefinition.hooks.afterTurn({
            sessionId: params.sessionId,
            input,
            providerId: activeProviderId,
            runtime: this.runtimeContext(),
            output: {
              historyCount: manager.getSessionHistory(params.sessionId).length
            }
          });
        } catch (error) {
          this.degradedReasons.push(
            `Agent afterTurn hook failed: ${error instanceof Error ? error.message : String(error)}`
          );
          this.state = "degraded";
        }
      }
      this.persistSessionState(params.sessionId);
    }
  }

  private resolveOrchestrationMode(): OrchestrationMode {
    const mode = this.config.orchestration?.defaultMode ?? "queue";
    if (mode === "interrupt" || mode === "collect" || mode === "steer" || mode === "steer_backlog") {
      return mode;
    }
    return "queue";
  }

  private laneForSession(sessionId: string): ChannelLaneState {
    const existing = this.channelLanes.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: ChannelLaneState = {
      mode: this.resolveOrchestrationMode(),
      cap: Math.max(1, this.config.orchestration?.defaultCap ?? 32),
      dropPolicy: this.config.orchestration?.dropPolicy ?? "old",
      collectDebounceMs: Math.max(0, this.config.orchestration?.collectDebounceMs ?? 350),
      queue: [],
      active: null,
      collectTimer: null
    };
    this.channelLanes.set(sessionId, created);
    return created;
  }

  private async runChannelTurnDirect(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }): Promise<ChannelTurnResult> {
    await this.runSessionTurn({
      sessionId: params.sessionId,
      input: params.input,
      onEvent: params.onEvent,
      signal: params.signal
    });

    const history = this.getSessionHistory(params.sessionId);
    let response = "";
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.role === "assistant") {
        response = message.content;
        break;
      }
    }

    const state = this.getSessionState(params.sessionId);
    return {
      sessionId: params.sessionId,
      providerId: state?.activeProviderId,
      response
    };
  }

  private queueDrop(lane: ChannelLaneState): PendingChannelTurn | null {
    if (lane.queue.length < lane.cap) {
      return null;
    }
    if (lane.dropPolicy === "new") {
      return {
        input: "",
        onEvent: () => undefined,
        resolve: () => undefined,
        reject: () => undefined,
        enqueuedAt: nowIso()
      };
    }
    const dropped = lane.queue.shift() ?? null;
    return dropped;
  }

  private startLaneExecution(sessionId: string, lane: ChannelLaneState): void {
    if (lane.active) {
      return;
    }

    const mode = lane.mode;
    const takeNext = (): ActiveChannelTurn | null => {
      if (lane.queue.length === 0) {
        return null;
      }
      if (mode === "collect") {
        const batch = [...lane.queue];
        lane.queue.length = 0;
        const input = batch.map((entry) => entry.input).join("\n\n");
        const onEvent: StreamEventHandler = (event) => {
          for (const entry of batch) {
            entry.onEvent(event);
          }
        };
        return {
          input,
          onEvent,
          resolveMany: batch.map((entry) => entry.resolve),
          rejectMany: batch.map((entry) => entry.reject),
          controller: new AbortController()
        };
      }
      const next = lane.queue.shift();
      if (!next) {
        return null;
      }
      return {
        input: next.input,
        onEvent: next.onEvent,
        resolveMany: [next.resolve],
        rejectMany: [next.reject],
        controller: new AbortController()
      };
    };

    const active = takeNext();
    if (!active) {
      return;
    }
    lane.active = active;
    this.emitRuntimeEvent("orchestration.started", {
      sessionId,
      mode: lane.mode,
      queued: lane.queue.length
    });

    void this.runChannelTurnDirect({
      sessionId,
      input: active.input,
      onEvent: active.onEvent,
      signal: active.controller.signal
    })
      .then((result) => {
        for (const resolve of active.resolveMany) {
          resolve(result);
        }
        this.emitRuntimeEvent("orchestration.completed", {
          sessionId,
          mode: lane.mode,
          queued: lane.queue.length
        });
      })
      .catch((error) => {
        for (const reject of active.rejectMany) {
          reject(error);
        }
      })
      .finally(() => {
        lane.active = null;
        if (lane.collectTimer) {
          clearTimeout(lane.collectTimer);
          lane.collectTimer = null;
        }
        this.startLaneExecution(sessionId, lane);
      });
  }

  private submitChannelTurnToLane(params: {
    sessionId: string;
    input: string;
    onEvent: StreamEventHandler;
  }): Promise<ChannelTurnResult> {
    const lane = this.laneForSession(params.sessionId);
    this.emitRuntimeEvent("orchestration.submitted", {
      sessionId: params.sessionId,
      mode: lane.mode,
      queued: lane.queue.length
    });

    return new Promise<ChannelTurnResult>((resolve, reject) => {
      const pending: PendingChannelTurn = {
        input: params.input,
        onEvent: params.onEvent,
        resolve,
        reject,
        enqueuedAt: nowIso()
      };

      const effectiveMode: OrchestrationMode =
        lane.mode === "steer" ? "interrupt" : lane.mode === "steer_backlog" ? "queue" : lane.mode;

      if (effectiveMode === "interrupt") {
        for (const queued of lane.queue.splice(0)) {
          queued.reject(new Error("Dropped by interrupt queue policy"));
        }
        lane.active?.controller.abort();
        lane.queue.push(pending);
        this.startLaneExecution(params.sessionId, lane);
        return;
      }

      const dropped = this.queueDrop(lane);
      if (dropped) {
        if (lane.dropPolicy === "new") {
          reject(new Error("Queue is full (dropPolicy=new)"));
          this.emitRuntimeEvent("orchestration.dropped", {
            sessionId: params.sessionId,
            mode: lane.mode,
            dropPolicy: lane.dropPolicy
          });
          return;
        }
        dropped.reject(new Error("Dropped by queue capacity policy"));
        this.emitRuntimeEvent("orchestration.dropped", {
          sessionId: params.sessionId,
          mode: lane.mode,
          dropPolicy: lane.dropPolicy
        });
      }

      lane.queue.push(pending);
      if (effectiveMode === "collect" && lane.active) {
        return;
      }
      if (effectiveMode === "collect" && lane.collectDebounceMs > 0) {
        if (lane.collectTimer) {
          clearTimeout(lane.collectTimer);
        }
        lane.collectTimer = setTimeout(() => {
          lane.collectTimer = null;
          this.startLaneExecution(params.sessionId, lane);
        }, lane.collectDebounceMs);
        return;
      }
      this.startLaneExecution(params.sessionId, lane);
    });
  }

  async runChannelTurn(params: ChannelTurnRequest): Promise<ChannelTurnResult> {
    const sessionId = this.resolveChannelSession({
      identity: params.identity,
      mapping: params.mapping,
      title: params.title
    });
    const onEvent: StreamEventHandler = params.onEvent ?? (() => undefined);
    const orchestrationEnabled = this.config.orchestration?.enabled ?? false;
    if (!orchestrationEnabled) {
      return await this.runChannelTurnDirect({
        sessionId,
        input: params.input,
        onEvent,
        signal: params.signal
      });
    }

    return await this.submitChannelTurnToLane({
      sessionId,
      input: params.input,
      onEvent
    });
  }

  registerChannelAdapter(adapter: ChannelAdapter): void {
    const channelId = adapter.id.trim();
    if (!channelId) {
      throw new Error("Channel adapter id is required");
    }
    if (this.channelAdapters.has(channelId)) {
      throw new Error(`Channel adapter already registered: ${channelId}`);
    }
    this.channelAdapters.set(channelId, adapter);
  }

  unregisterChannelAdapter(channelId: string): boolean {
    return this.channelAdapters.delete(channelId.trim());
  }

  listChannelAdapterIds(): string[] {
    return Array.from(this.channelAdapters.keys()).sort((left, right) => left.localeCompare(right));
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.config.providers ? [...this.config.providers.profiles] : [];
  }

  getProviderFailoverStatus(): unknown {
    const manager = this.ensureProviderManager();
    return manager?.getFailoverStatus() ?? null;
  }

  async probeProviders(timeoutMs = 10_000): Promise<ProviderProbeResult[]> {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return [];
    }
    const diagnostics = await manager.probeAll({
      authStore: this.authStore,
      timeoutMs
    });
    this.providerDiagnostics = diagnostics;
    return diagnostics;
  }

  listSessionSnapshots(): SessionSnapshot[] {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return [];
    }
    const snapshots = new Map<string, SessionSnapshot>();
    for (const session of manager.listSessions()) {
      snapshots.set(session.sessionId, {
        sessionId: session.sessionId,
        activeProviderId: session.activeProviderId,
        pendingProviderId: session.pendingProviderId,
        turnInProgress: session.turnInProgress,
        historyCount: session.history.length,
        metadata: {
          ...session.metadata
        }
      });
    }

    if (this.sessionStoreEnabled) {
      for (const entry of listSessionIndex(this.sessionDirectory)) {
        if (snapshots.has(entry.sessionId)) {
          continue;
        }
        snapshots.set(entry.sessionId, {
          sessionId: entry.sessionId,
          activeProviderId: entry.activeProviderId ?? this.config.providers?.defaultSessionProvider ?? "local",
          pendingProviderId: entry.pendingProviderId,
          turnInProgress: false,
          historyCount: entry.historyCount,
          metadata: {
            createdAt: entry.createdAt,
            lastActivityAt: entry.lastActivityAt,
            title: entry.title,
            origin: entry.origin
          }
        });
      }
    }

    return Array.from(snapshots.values()).sort((left, right) => {
      const leftTs = Date.parse(left.metadata.lastActivityAt);
      const rightTs = Date.parse(right.metadata.lastActivityAt);
      if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
        return rightTs - leftTs;
      }
      return left.sessionId.localeCompare(right.sessionId);
    });
  }

  getSessionHistory(sessionId: string): ChatMessage[] {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return [];
    }
    const liveHistory = manager.getSessionHistory(sessionId);
    if (liveHistory.length > 0) {
      return liveHistory;
    }
    if (!this.sessionStoreEnabled) {
      return [];
    }
    return loadSessionRecordWithDiagnostics(this.sessionDirectory, sessionId).record?.history ?? [];
  }

  deleteSession(sessionId: string): SessionMutationResult {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return {
        ok: false,
        message: "No provider manager configured"
      };
    }

    let deletedLive = false;
    const live = manager.getSession(sessionId);
    if (live) {
      try {
        deletedLive = manager.deleteSession(sessionId);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }

    let deletedPersisted = false;
    if (this.sessionStoreEnabled) {
      deletedPersisted = deleteSessionRecord({
        sessionDirectory: this.sessionDirectory,
        sessionId,
        lock: this.sessionLockOptions()
      });
    }

    if (!deletedLive && !deletedPersisted) {
      return {
        ok: false,
        message: `Unknown session: ${sessionId}`
      };
    }

    this.emitRuntimeEvent("gateway.config.reloaded", {
      action: "session.delete",
      sessionId
    });
    return {
      ok: true,
      message: `Deleted session ${sessionId}`,
      sessionId
    };
  }

  renameSession(params: { fromSessionId: string; toSessionId: string }): SessionMutationResult {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return {
        ok: false,
        message: "No provider manager configured"
      };
    }

    if (manager.getSession(params.toSessionId)) {
      return {
        ok: false,
        message: `Session already exists: ${params.toSessionId}`
      };
    }
    const sourceLive = manager.getSession(params.fromSessionId);
    if (sourceLive?.turnInProgress) {
      return {
        ok: false,
        message: `Cannot rename session in progress: ${params.fromSessionId}`
      };
    }

    let renamedPersisted = false;
    if (this.sessionStoreEnabled) {
      try {
        renameSessionRecord({
          sessionDirectory: this.sessionDirectory,
          fromSessionId: params.fromSessionId,
          toSessionId: params.toSessionId,
          lock: this.sessionLockOptions()
        });
        renamedPersisted = true;
      } catch (error) {
        const loaded = manager.getSession(params.fromSessionId);
        if (!loaded || !(error instanceof SessionStoreError) || error.code !== "not_found") {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }
    }

    let renamedLive = false;
    if (sourceLive) {
      try {
        manager.renameSession({
          fromSessionId: params.fromSessionId,
          toSessionId: params.toSessionId
        });
        renamedLive = true;
      } catch (error) {
        if (renamedPersisted) {
          try {
            renameSessionRecord({
              sessionDirectory: this.sessionDirectory,
              fromSessionId: params.toSessionId,
              toSessionId: params.fromSessionId,
              overwrite: true,
              lock: this.sessionLockOptions()
            });
          } catch {
            // best effort rollback
          }
        }
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }

    if (!renamedPersisted && !renamedLive) {
      return {
        ok: false,
        message: `Unknown session: ${params.fromSessionId}`
      };
    }

    this.emitRuntimeEvent("gateway.config.reloaded", {
      action: "session.rename",
      fromSessionId: params.fromSessionId,
      toSessionId: params.toSessionId
    });
    return {
      ok: true,
      message: `Renamed session ${params.fromSessionId} -> ${params.toSessionId}`,
      sessionId: params.toSessionId
    };
  }

  exportSession(sessionId: string): LoadedSessionRecord | null {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return null;
    }
    const live = manager.getSession(sessionId);
    if (live) {
      return {
        sessionId: live.sessionId,
        activeProviderId: live.activeProviderId,
        pendingProviderId: live.pendingProviderId,
        history: [...live.history],
        metadata: {
          ...live.metadata
        },
        revision: 0,
        updatedAt: nowIso()
      };
    }
    if (!this.sessionStoreEnabled) {
      return null;
    }
    return exportSessionRecord({
      sessionDirectory: this.sessionDirectory,
      sessionId
    });
  }

  importSession(params: {
    record: LoadedSessionRecord;
    overwrite?: boolean;
  }): SessionMutationResult {
    const manager = this.ensureProviderManager();
    if (!manager) {
      return {
        ok: false,
        message: "No provider manager configured"
      };
    }

    const existing = manager.getSession(params.record.sessionId);
    if (existing && !params.overwrite) {
      return {
        ok: false,
        message: `Session already exists: ${params.record.sessionId}`
      };
    }
    if (existing?.turnInProgress) {
      return {
        ok: false,
        message: `Cannot overwrite session in progress: ${params.record.sessionId}`
      };
    }

    try {
      const imported = this.sessionStoreEnabled
        ? importSessionRecord({
            sessionDirectory: this.sessionDirectory,
            record: params.record,
            overwrite: params.overwrite,
            lock: this.sessionLockOptions()
          })
        : params.record;
      const initialProviderId =
        imported.activeProviderId ?? this.config.providers?.defaultSessionProvider ?? params.record.activeProviderId;
      if (!initialProviderId) {
        return {
          ok: false,
          message: "Imported session must define an active provider"
        };
      }
      manager.ensureSession(imported.sessionId, initialProviderId);
      manager.hydrateSession({
        sessionId: imported.sessionId,
        history: imported.history,
        activeProviderId: imported.activeProviderId,
        pendingProviderId: imported.pendingProviderId,
        metadata: imported.metadata
      });
      return {
        ok: true,
        message: `Imported session ${imported.sessionId}`,
        sessionId: imported.sessionId
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  archiveStaleSessions(maxIdleMs?: number): string[] {
    if (!this.sessionStoreEnabled) {
      return [];
    }
    const idleMs = maxIdleMs ?? this.config.sessionStore?.retention?.archiveAfterIdleMs;
    if (!idleMs || idleMs <= 0) {
      return [];
    }
    const now = Date.now();
    const archived: string[] = [];
    const index = listSessionIndex(this.sessionDirectory);
    const manager = this.ensureProviderManager();
    for (const entry of index) {
      const lastActivity = Date.parse(entry.lastActivityAt);
      if (!Number.isFinite(lastActivity)) {
        continue;
      }
      if (now - lastActivity < idleMs) {
        continue;
      }
      const live = manager?.getSession(entry.sessionId);
      if (live?.turnInProgress) {
        continue;
      }
      const result = archiveSessionRecord({
        sessionDirectory: this.sessionDirectory,
        sessionId: entry.sessionId,
        lock: this.sessionLockOptions()
      });
      if (result) {
        archived.push(entry.sessionId);
        manager?.deleteSession(entry.sessionId);
      }
    }
    return archived;
  }

  enforceSessionRetention(): { archived: string[]; deleted: string[] } {
    if (!this.sessionStoreEnabled) {
      return {
        archived: [],
        deleted: []
      };
    }

    const policy = this.config.sessionStore?.retention;
    if (!policy) {
      return {
        archived: [],
        deleted: []
      };
    }

    const now = Date.now();
    const manager = this.ensureProviderManager();
    const archiveFirst = policy.archiveFirst ?? true;
    const protectedSessions = new Set<string>();
    for (const session of manager?.listSessions() ?? []) {
      if (session.turnInProgress) {
        protectedSessions.add(session.sessionId);
      }
    }

    const entries = listSessionIndex(this.sessionDirectory);
    const removed = new Set<string>();
    const archived: string[] = [];
    const deleted: string[] = [];

    const removeSession = (sessionId: string): void => {
      if (!sessionId || removed.has(sessionId) || protectedSessions.has(sessionId)) {
        return;
      }
      if (archiveFirst) {
        const archivedResult = archiveSessionRecord({
          sessionDirectory: this.sessionDirectory,
          sessionId,
          lock: this.sessionLockOptions()
        });
        if (archivedResult) {
          archived.push(sessionId);
          removed.add(sessionId);
          manager?.deleteSession(sessionId);
          return;
        }
      }
      const deletedResult = deleteSessionRecord({
        sessionDirectory: this.sessionDirectory,
        sessionId,
        lock: this.sessionLockOptions()
      });
      if (deletedResult) {
        deleted.push(sessionId);
        removed.add(sessionId);
        manager?.deleteSession(sessionId);
      }
    };

    const maxAgeDays = policy.maxAgeDays ?? 0;
    if (maxAgeDays > 0) {
      const ageCutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        const lastActivityMs = Date.parse(entry.lastActivityAt);
        if (!Number.isFinite(lastActivityMs)) {
          continue;
        }
        if (lastActivityMs <= ageCutoffMs) {
          removeSession(entry.sessionId);
        }
      }
    }

    const archiveAfterIdleMs = policy.archiveAfterIdleMs ?? 0;
    if (archiveAfterIdleMs > 0) {
      for (const entry of entries) {
        if (removed.has(entry.sessionId)) {
          continue;
        }
        const lastActivityMs = Date.parse(entry.lastActivityAt);
        if (!Number.isFinite(lastActivityMs)) {
          continue;
        }
        if (now - lastActivityMs >= archiveAfterIdleMs) {
          removeSession(entry.sessionId);
        }
      }
    }

    const remaining = entries
      .filter((entry) => !removed.has(entry.sessionId))
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));

    const maxSessions = policy.maxSessions ?? 0;
    if (maxSessions > 0 && remaining.length > maxSessions) {
      for (const entry of remaining.slice(maxSessions)) {
        removeSession(entry.sessionId);
      }
    }

    const maxTotalBytes = policy.maxTotalBytes ?? 0;
    if (maxTotalBytes > 0) {
      const latestEntries = listSessionIndex(this.sessionDirectory)
        .filter((entry) => !removed.has(entry.sessionId))
        .sort((left, right) => Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt));
      let totalBytes = latestEntries.reduce((sum, entry) => sum + sessionStorageBytes(this.sessionDirectory, entry.sessionId), 0);
      for (const entry of latestEntries) {
        if (totalBytes <= maxTotalBytes) {
          break;
        }
        const bytes = sessionStorageBytes(this.sessionDirectory, entry.sessionId);
        removeSession(entry.sessionId);
        totalBytes = Math.max(0, totalBytes - bytes);
      }
    }

    return {
      archived,
      deleted
    };
  }

  resolveChannelSession(params: {
    identity: ChannelSessionIdentity;
    mapping?: ChannelSessionMappingOptions;
    title?: string;
  }): string {
    const channelKey = this.channelSessionKey(params.identity, params.mapping);
    const mapped = this.channelSessionAssignments.get(channelKey);
    const sessionId = mapped ?? channelKey;
    this.ensureSession(sessionId, {
      title: params.title,
      origin: createChannelSessionOrigin(params.identity)
    });
    if (!mapped) {
      this.channelSessionAssignments.set(channelKey, sessionId);
    }
    return sessionId;
  }

  listLoadedToolNames(): string[] {
    return Array.from(this.toolRegistry.keys()).sort((left, right) => left.localeCompare(right));
  }

  listPersistedSessionIds(): string[] {
    if (!this.sessionStoreEnabled) {
      return [];
    }
    return listSessionIds(this.sessionDirectory);
  }

  listContinuityJobs(limit = 20): unknown[] {
    if (!this.continuityRuntime) {
      return [];
    }
    return this.continuityRuntime.listJobs(limit);
  }
}

export function createGateway(config: GatewayConfig, params?: { exit?: (code: number) => never | void }): GatewayRuntime {
  return new GatewayRuntime({
    config,
    exit: params?.exit
  });
}
