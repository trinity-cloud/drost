import path from "node:path";
import { PluginRuntime } from "../../plugins/runtime.js";
import { SkillRuntime } from "../../skills/runtime.js";
import { OptionalModuleRuntime } from "../../optional/runtime.js";
import type { GatewayStatus } from "../../gateway.js";
import { buildToolRegistry } from "../../tools.js";
import { ensureDirectory, nowIso } from "../helpers.js";
import {
  buildBootToolList,
  connectChannels,
  createSubagentManager,
  disconnectChannels,
  loadConfiguredAgentDefinition
} from "./subsystems.js";

export async function start(runtime: any): Promise<GatewayStatus> {
  if (runtime.state === "running" || runtime.state === "degraded") {
    return runtime.getStatus();
  }
  runtime.suppressOrchestrationPersistence = false;

  runtime.emitRuntimeEvent("gateway.starting", {
    workspaceDir: runtime.workspaceDir,
    toolDirectory: runtime.toolDirectory,
    agentEntryPath: runtime.agentEntryPath
  });

  ensureDirectory(runtime.workspaceDir);
  ensureDirectory(runtime.toolDirectory);
  ensureDirectory(path.dirname(runtime.restartHistoryPath));
  if (runtime.sessionStoreEnabled) {
    ensureDirectory(runtime.sessionDirectory);
  }

  runtime.degradedReasons = [];
  runtime.providerDiagnostics = [];
  runtime.ensureObservabilityDirectory();
  runtime.loadRestartHistory();
  runtime.restoreOrchestrationState();
  await loadConfiguredAgentDefinition(runtime);

  runtime.pluginRuntime =
    runtime.config.plugins?.enabled === true
      ? new PluginRuntime({
          workspaceDir: runtime.workspaceDir,
          context: runtime.runtimeContext(),
          config: runtime.config.plugins
        })
      : null;
  if (runtime.pluginRuntime) {
    await runtime.pluginRuntime.load();
    for (const blocked of runtime.pluginRuntime.getStatus().blocked) {
      runtime.degradedReasons.push(
        `Plugin blocked (${blocked.reason}) ${blocked.pluginId ?? blocked.modulePath}: ${blocked.message}`
      );
    }
    for (const pluginChannels of runtime.pluginRuntime.listChannels()) {
      for (const channel of pluginChannels.channels ?? []) {
        try {
          runtime.registerChannelAdapter(channel);
        } catch (error) {
          runtime.degradedReasons.push(
            `Plugin ${pluginChannels.pluginId} channel registration failed (${channel.id}): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  runtime.skillRuntime =
    runtime.config.skills?.enabled === true
      ? new SkillRuntime({
          workspaceDir: runtime.workspaceDir,
          config: runtime.config.skills
        })
      : null;
  runtime.skillRuntime?.refresh();
  runtime.subagentManager = createSubagentManager(runtime);
  runtime.optionalModuleRuntime = new OptionalModuleRuntime({
    workspaceDir: runtime.workspaceDir,
    config: runtime.config.optionalModules
  });

  const toolRegistryResult = await buildToolRegistry({
    builtInTools: buildBootToolList(runtime),
    customToolsDirectory: runtime.toolDirectory
  });

  runtime._toolDiagnostics = toolRegistryResult.diagnostics;
  runtime.toolRegistry = toolRegistryResult.tools;
  if (toolRegistryResult.diagnostics.skipped.length > 0) {
    runtime.degradedReasons.push(
      `Skipped ${toolRegistryResult.diagnostics.skipped.length} invalid or conflicting custom tool(s)`
    );
  }

  if (runtime.config.providers) {
    runtime.ensureProviderManager();
    runtime.validateProviderRoutes();
    const probeEnabled = runtime.config.providers.startupProbe?.enabled ?? true;
    if (probeEnabled && runtime.providerManager) {
      const timeoutMs = runtime.config.providers.startupProbe?.timeoutMs ?? 10_000;
      runtime.providerDiagnostics = await runtime.providerManager.probeAll({
        authStore: runtime.authStore,
        timeoutMs
      });
      const failed = runtime.providerDiagnostics.filter((entry: { ok: boolean }) => !entry.ok);
      if (failed.length > 0) {
        runtime.degradedReasons.push(`${failed.length} provider profile(s) failed startup capability probe`);
      }
    }
  }

  try {
    await runtime.startHealthServer();
  } catch (error) {
    runtime.degradedReasons.push(
      `Health endpoint failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    await runtime.startControlServer();
  } catch (error) {
    runtime.degradedReasons.push(
      `Control API failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (runtime.agentDefinition?.hooks?.onStart) {
    try {
      await runtime.agentDefinition.hooks.onStart(runtime.runtimeContext());
    } catch (error) {
      runtime.degradedReasons.push(`Agent onStart hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (runtime.pluginRuntime) {
    await runtime.pluginRuntime.start();
    for (const runtimeError of runtime.pluginRuntime.getStatus().runtimeErrors) {
      runtime.degradedReasons.push(
        `Plugin ${runtimeError.pluginId} ${runtimeError.phase} error: ${runtimeError.message}`
      );
    }
  }
  runtime.optionalModuleRuntime.start();
  for (const status of runtime.optionalModuleRuntime.listStatuses()) {
    if (status.enabled && !status.healthy) {
      runtime.degradedReasons.push(`Optional module ${status.module} unhealthy: ${status.message}`);
    }
  }
  runtime.subagentManager?.start();

  await connectChannels(runtime);
  await runtime.config.hooks?.onStart?.();

  runtime.startedAt = nowIso();
  runtime.state = runtime.degradedReasons.length > 0 ? "degraded" : "running";
  runtime.emitRuntimeEvent("gateway.started", {
    state: runtime.state,
    startedAt: runtime.startedAt,
    healthUrl: runtime.healthUrl,
    controlUrl: runtime.controlUrl
  });
  if (runtime.degradedReasons.length > 0) {
    runtime.emitRuntimeEvent("gateway.degraded", {
      reasons: [...runtime.degradedReasons]
    });
  }
  try {
    runtime.enforceSessionRetention();
  } catch (error) {
    runtime.degradedReasons.push(
      `Session retention enforcement failed at startup: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.state = "degraded";
  }
  return runtime.getStatus();
}

export async function stop(runtime: any): Promise<void> {
  if (runtime.state === "stopped") {
    return;
  }
  runtime.emitRuntimeEvent("gateway.stopping", {
    state: runtime.state
  });

  if (runtime.shouldPersistOrchestrationState()) {
    try {
      runtime.writeOrchestrationState(runtime.persistedLaneStateSnapshot());
    } catch (error) {
      runtime.degradedReasons.push(
        `Failed to persist orchestration lane state: ${error instanceof Error ? error.message : String(error)}`
      );
      runtime.state = "degraded";
    }
  }

  runtime.suppressOrchestrationPersistence = true;
  await runtime.stopControlServer();
  await runtime.stopHealthServer();
  for (const lane of runtime.channelLanes.values()) {
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
  runtime.channelLanes.clear();

  await disconnectChannels(runtime);
  await runtime.subagentManager?.stop();
  runtime.optionalModuleRuntime?.stop();
  if (runtime.pluginRuntime) {
    await runtime.pluginRuntime.stop();
  }
  if (runtime.agentDefinition?.hooks?.onStop) {
    try {
      await runtime.agentDefinition.hooks.onStop(runtime.runtimeContext());
    } catch (error) {
      runtime.degradedReasons.push(`Agent onStop hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await runtime.config.hooks?.onShutdown?.();
  runtime.subagentManager = null;
  runtime.skillRuntime = null;
  runtime.pluginRuntime = null;
  runtime.optionalModuleRuntime = null;
  runtime.state = "stopped";
  runtime.emitRuntimeEvent("gateway.stopped", {
    state: runtime.state
  });
}
