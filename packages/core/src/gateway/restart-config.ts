import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RESTART_EXIT_CODE } from "../constants.js";
import type {
  GatewayConfig,
  GatewayRestartIntent,
  GatewayRestartRequestContext,
  GatewayGitCheckpointResult
} from "../config.js";
import type {
  GatewayConfigReloadResult,
  GatewayConfigReloadRejection,
  GatewayRestartRequest,
  GatewayRestartResult
} from "../gateway.js";
import { ensureDirectory, nowIso, restartIntent, toText } from "./helpers.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RESTART_BUDGET_MAX = 5;
const DEFAULT_RESTART_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RESTART_BUDGET_INTENTS: ReadonlySet<GatewayRestartIntent> = new Set(["self_mod", "config_change"]);

export function loadRestartHistory(runtime: any): void {
  try {
    const raw = fs.readFileSync(runtime.restartHistoryPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      runtime.restartHistory = [];
      return;
    }
    runtime.restartHistory = parsed
      .filter((entry: unknown) => entry && typeof entry === "object")
      .map((entry) => entry as { timestamp?: unknown; intent?: unknown })
      .filter((entry) => typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))
      .map((entry) => ({
        timestamp: entry.timestamp as number,
        intent: restartIntent(typeof entry.intent === "string" ? (entry.intent as GatewayRestartIntent) : "manual")
      }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      runtime.degradedReasons.push(
        `Failed to load restart history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    runtime.restartHistory = [];
  }
}

export function saveRestartHistory(runtime: any): void {
  try {
    ensureDirectory(path.dirname(runtime.restartHistoryPath));
    fs.writeFileSync(runtime.restartHistoryPath, JSON.stringify(runtime.restartHistory, null, 2));
  } catch (error) {
    runtime.degradedReasons.push(
      `Failed to save restart history: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
}

export function pruneRestartHistory(runtime: any, windowMs: number, nowMs: number): void {
  const earliest = nowMs - windowMs;
  runtime.restartHistory = runtime.restartHistory.filter((entry: { timestamp: number }) => entry.timestamp >= earliest);
}

export function resolveBudgetPolicy(runtime: any): {
  enabled: boolean;
  maxRestarts: number;
  windowMs: number;
  intents: ReadonlySet<GatewayRestartIntent>;
} {
  const budget = runtime.config.restartPolicy?.budget;
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

export async function runGitCheckpoint(
  runtime: any,
  request: GatewayRestartRequestContext
): Promise<GatewayGitCheckpointResult> {
  const configured = runtime.config.restartPolicy?.gitSafety;
  if (configured?.checkpoint) {
    return await configured.checkpoint(request);
  }

  try {
    await execFileAsync("git", ["-C", runtime.workspaceDir, "rev-parse", "--is-inside-work-tree"], {
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
    await execFileAsync("git", ["-C", runtime.workspaceDir, "add", "-A"], {
      encoding: "utf8"
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const checkpointMessage =
    configured?.checkpointMessage ?? `drost: pre-restart checkpoint (${request.intent}) ${request.timestamp}`;
  try {
    await execFileAsync("git", ["-C", runtime.workspaceDir, "commit", "-m", checkpointMessage], {
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

export async function validateRestart(runtime: any, request: GatewayRestartRequest = {}): Promise<GatewayRestartResult> {
  const now = nowIso();
  const context: GatewayRestartRequestContext = {
    intent: restartIntent(request.intent),
    reason: request.reason,
    sessionId: request.sessionId,
    providerId: request.providerId,
    dryRun: true,
    timestamp: now
  };
  return await evaluateRestartPolicy(runtime, context);
}

export async function evaluateRestartPolicy(
  _runtime: any,
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

export async function requestRestart(
  runtime: any,
  request: GatewayRestartRequest = {}
): Promise<GatewayRestartResult | never | void> {
  const context: GatewayRestartRequestContext = {
    intent: restartIntent(request.intent),
    reason: request.reason,
    sessionId: request.sessionId,
    providerId: request.providerId,
    dryRun: request.dryRun ?? false,
    timestamp: nowIso()
  };

  runtime.emitRuntimeEvent("gateway.restart.requested", {
    intent: context.intent,
    reason: context.reason,
    sessionId: context.sessionId,
    providerId: context.providerId,
    dryRun: context.dryRun
  });

  const decision = await evaluateRestartPolicy(runtime, context);
  if (!decision.ok) {
    runtime.emitRuntimeEvent("gateway.restart.blocked", {
      intent: context.intent,
      code: decision.code,
      message: decision.message,
      dryRun: context.dryRun
    });
    return decision;
  }

  runtime.emitRuntimeEvent("gateway.restart.validated", {
    intent: context.intent,
    dryRun: context.dryRun
  });

  if (context.dryRun) {
    return decision;
  }

  await runtime.config.hooks?.onRestart?.();

  runtime.restartHistory.push({
    timestamp: Date.now(),
    intent: context.intent
  });
  saveRestartHistory(runtime);

  runtime.emitRuntimeEvent("gateway.restart.executing", {
    intent: context.intent,
    reason: context.reason
  });

  await runtime.stop();
  return runtime.exit(RESTART_EXIT_CODE);
}

export async function reloadConfig(
  runtime: any,
  patch: Partial<GatewayConfig>
): Promise<GatewayConfigReloadResult> {
  const applied: string[] = [];
  const rejected: GatewayConfigReloadRejection[] = [];

  if (patch.workspaceDir !== undefined && patch.workspaceDir !== runtime.config.workspaceDir) {
    rejected.push({
      path: "workspaceDir",
      reason: "restart_required",
      message: "workspaceDir requires restart and full gateway re-bootstrap"
    });
  }
  if (patch.toolDirectory !== undefined && patch.toolDirectory !== runtime.config.toolDirectory) {
    rejected.push({
      path: "toolDirectory",
      reason: "restart_required",
      message: "toolDirectory requires restart to rebuild tool registry"
    });
  }
  if (patch.authStorePath !== undefined && patch.authStorePath !== runtime.config.authStorePath) {
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
  if (patch.failover !== undefined) {
    rejected.push({
      path: "failover",
      reason: "restart_required",
      message: "failover configuration requires restart to rebuild provider manager"
    });
  }
  if (patch.plugins !== undefined) {
    rejected.push({
      path: "plugins",
      reason: "restart_required",
      message: "plugin runtime configuration requires restart"
    });
  }
  if (patch.skills !== undefined) {
    rejected.push({
      path: "skills",
      reason: "restart_required",
      message: "skills runtime configuration requires restart"
    });
  }
  if (patch.subagents !== undefined) {
    rejected.push({
      path: "subagents",
      reason: "restart_required",
      message: "subagent runtime configuration requires restart"
    });
  }
  if (patch.optionalModules !== undefined) {
    rejected.push({
      path: "optionalModules",
      reason: "restart_required",
      message: "optional module configuration requires restart"
    });
  }

  if (patch.health) {
    runtime.config.health = {
      ...(runtime.config.health ?? {}),
      ...patch.health
    };
    applied.push("health");
    if (runtime.state === "running" || runtime.state === "degraded") {
      await runtime.stopHealthServer();
      try {
        await runtime.startHealthServer();
      } catch (error) {
        runtime.degradedReasons.push(
          `Health endpoint failed to start during reload: ${error instanceof Error ? error.message : String(error)}`
        );
        runtime.state = "degraded";
      }
    }
  }

  if (patch.toolPolicy) {
    runtime.config.toolPolicy = {
      ...(runtime.config.toolPolicy ?? {}),
      ...patch.toolPolicy
    };
    applied.push("toolPolicy");
  }

  if (patch.providerRouter) {
    runtime.config.providerRouter = {
      ...(runtime.config.providerRouter ?? {}),
      ...patch.providerRouter,
      routes: patch.providerRouter.routes ?? runtime.config.providerRouter?.routes
    };
    applied.push("providerRouter");
  }

  if (patch.orchestration) {
    runtime.config.orchestration = {
      ...(runtime.config.orchestration ?? {}),
      ...patch.orchestration
    };
    applied.push("orchestration");
    runtime.persistOrchestrationState();
  }

  if (patch.controlApi) {
    runtime.config.controlApi = {
      ...(runtime.config.controlApi ?? {}),
      ...patch.controlApi
    };
    applied.push("controlApi");
    if (runtime.state === "running" || runtime.state === "degraded") {
      await runtime.stopControlServer();
      try {
        await runtime.startControlServer();
      } catch (error) {
        runtime.degradedReasons.push(
          `Control API failed to start during reload: ${error instanceof Error ? error.message : String(error)}`
        );
        runtime.state = "degraded";
      }
    }
  }

  if (patch.observability) {
    runtime.config.observability = {
      ...(runtime.config.observability ?? {}),
      ...patch.observability
    };
    if (patch.observability.directory !== undefined) {
      runtime.observabilityDirectory = path.resolve(patch.observability.directory);
    }
    runtime.observabilityWriteFailed = false;
    runtime.ensureObservabilityDirectory();
    applied.push("observability");
  }

  if (patch.providers?.startupProbe) {
    const currentProviders = runtime.config.providers;
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
    runtime.config.restartPolicy = {
      ...(runtime.config.restartPolicy ?? {}),
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
  runtime.emitRuntimeEvent("gateway.config.reloaded", {
    ok: result.ok,
    applied,
    rejected,
    restartRequired
  });
  return result;
}
