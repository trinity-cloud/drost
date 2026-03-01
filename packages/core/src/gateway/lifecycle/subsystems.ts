import fs from "node:fs";
import type { ChannelCommandRequest } from "../../channels.js";
import type { ChannelCommandResult } from "../../channel-commands.js";
import { dispatchChannelCommand } from "../../channel-commands.js";
import { loadAgentDefinition } from "../../agent.js";
import type { ToolDefinition } from "../../tools.js";
import { createDefaultBuiltInTools } from "../../tools.js";
import { restartIntent } from "../helpers.js";
import { SubagentManager } from "../../subagents/manager.js";

export function createSubagentManager(runtime: any): SubagentManager | null {
  if (!(runtime.config.subagents?.enabled ?? false)) {
    return null;
  }
  return new SubagentManager({
    workspaceDir: runtime.workspaceDir,
    config: runtime.config.subagents,
    runtime: {
      runDelegatedTurn: async (params) => {
        runtime.ensureSession(params.subSessionId, {
          title: `Subagent ${params.jobId}`,
          origin: {
            channel: "subagent",
            threadId: params.sessionId
          }
        });
        if (params.providerId) {
          try {
            runtime.queueSessionProviderSwitch(params.subSessionId, params.providerId);
          } catch {
            // provider override is best-effort for delegated run
          }
        }
        await runtime.runSessionTurn({
          sessionId: params.subSessionId,
          input: params.input,
          onEvent: () => undefined,
          signal: params.signal
        });
        const response =
          runtime
            .getSessionHistory(params.subSessionId)
            .filter((message: { role: string; content: string }) => message.role === "assistant")
            .at(-1)?.content ?? "";
        return {
          response
        };
      },
      onStatusChange: (job) => {
        const statusEventType = (() => {
          if (job.status === "queued") {
            return "subagent.job.queued";
          }
          if (job.status === "running") {
            return "subagent.job.running";
          }
          if (job.status === "completed") {
            return "subagent.job.completed";
          }
          if (job.status === "cancelled") {
            return "subagent.job.cancelled";
          }
          if (job.status === "timed_out") {
            return "subagent.job.timed_out";
          }
          return "subagent.job.failed";
        })();
        runtime.emitRuntimeEvent(statusEventType, {
          jobId: job.jobId,
          sessionId: job.sessionId,
          status: job.status,
          subSessionId: job.subSessionId,
          error: job.error
        });
        runtime.appendSessionEvent(job.sessionId, "subagent.status", {
          jobId: job.jobId,
          status: job.status,
          subSessionId: job.subSessionId,
          error: job.error
        });
      }
    }
  });
}

export async function dispatchChannelCommandRequest(
  runtime: any,
  request: ChannelCommandRequest
): Promise<ChannelCommandResult> {
  const sessionId = runtime.resolveChannelSession({
    identity: request.identity,
    mapping: request.mapping
  });
  const result = await dispatchChannelCommand(
    runtime,
    {
      sessionId,
      identity: request.identity,
      mapping: request.mapping
    },
    request.input
  );
  return result;
}

export function scheduleSessionContinuity(runtime: any, fromSessionId: string, toSessionId: string): void {
  if (!runtime.sessionStoreEnabled || !runtime.continuityRuntime) {
    return;
  }
  const from = fromSessionId.trim();
  const to = toSessionId.trim();
  if (!from || !to || from === to) {
    return;
  }
  const job = runtime.continuityRuntime.schedule({
    fromSessionId: from,
    toSessionId: to
  });
  if (!job) {
    return;
  }
  runtime.appendSessionEvent(to, "continuity.queued", {
    jobId: job.jobId,
    fromSessionId: from,
    toSessionId: to
  });
  runtime.emitRuntimeEvent("gateway.degraded", {
    reason: "session_continuity_queued",
    jobId: job.jobId,
    fromSessionId: from,
    toSessionId: to
  });
}

export async function connectChannels(runtime: any): Promise<void> {
  if (runtime.channelAdapters.size === 0) {
    return;
  }
  const context = runtime.channelContext();
  for (const adapter of runtime.channelAdapters.values()) {
    try {
      await adapter.connect(context);
      runtime.emitRuntimeEvent("channel.connected", {
        channelId: adapter.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.degradedReasons.push(`Channel ${adapter.id} failed to connect: ${message}`);
      runtime.emitRuntimeEvent("channel.connection_failed", {
        channelId: adapter.id,
        message
      });
    }
  }
}

export async function disconnectChannels(runtime: any): Promise<void> {
  if (runtime.channelAdapters.size === 0) {
    return;
  }
  for (const adapter of runtime.channelAdapters.values()) {
    if (!adapter.disconnect) {
      continue;
    }
    try {
      await adapter.disconnect();
      runtime.emitRuntimeEvent("channel.disconnected", {
        channelId: adapter.id
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.degradedReasons.push(`Channel ${adapter.id} failed to disconnect: ${message}`);
    }
  }
}

export async function loadConfiguredAgentDefinition(runtime: any): Promise<void> {
  runtime.agentDefinition = null;
  if (!runtime.agentEntryPath) {
    return;
  }
  if (!fs.existsSync(runtime.agentEntryPath)) {
    const message = `Agent entry file not found: ${runtime.agentEntryPath}`;
    runtime.degradedReasons.push(message);
    runtime.emitRuntimeEvent("gateway.agent.failed", {
      entryPath: runtime.agentEntryPath,
      message
    });
    return;
  }

  const loaded = await loadAgentDefinition(runtime.agentEntryPath);
  if (!loaded.ok || !loaded.agent) {
    const message = `Failed to load agent entry ${runtime.agentEntryPath}: ${loaded.message ?? "unknown error"}`;
    runtime.degradedReasons.push(message);
    runtime.emitRuntimeEvent("gateway.agent.failed", {
      entryPath: runtime.agentEntryPath,
      message: loaded.message ?? "unknown error"
    });
    return;
  }

  runtime.agentDefinition = loaded.agent;
  runtime.emitRuntimeEvent("gateway.agent.loaded", {
    entryPath: runtime.agentEntryPath,
    name: loaded.agent.name
  });
}

export function buildBootToolList(runtime: any): ToolDefinition[] {
  const subagentEnabled = Boolean(runtime.subagentManager);
  const builtInTools =
    runtime.config.builtInTools ??
    createDefaultBuiltInTools({
      shellPolicy: runtime.config.shell,
      agent: {
        requestRestart: async (request) => {
          return await runtime.requestRestart({
            intent: restartIntent(request?.intent),
            reason: request?.reason,
            sessionId: request?.sessionId,
            providerId: request?.providerId,
            dryRun: request?.dryRun
          });
        },
        readStatus: () => runtime.getStatus(),
        listLoadedToolNames: () => runtime.listLoadedToolNames(),
        listSessionSnapshots: () => runtime.listSessionSnapshots(),
        startSubagent: subagentEnabled ? (params) => runtime.subagentManager!.startJob(params) : undefined,
        pollSubagent: subagentEnabled ? (jobId) => runtime.subagentManager!.getJob(jobId) : undefined,
        listSubagents: subagentEnabled ? (params) => runtime.subagentManager!.listJobs(params) : undefined,
        cancelSubagent: subagentEnabled ? (jobId) => runtime.subagentManager!.cancelJob(jobId) : undefined,
        readSubagentLogs: subagentEnabled
          ? (jobId, limit) => runtime.subagentManager!.readJobLogs(jobId, limit)
          : undefined
      }
    });

  const names = new Set<string>();
  const merged: ToolDefinition[] = [];
  for (const tool of builtInTools) {
    merged.push(tool);
    names.add(tool.name);
  }

  for (const pluginTools of runtime.pluginRuntime?.listTools() ?? []) {
    for (const tool of pluginTools.tools ?? []) {
      const normalizedName = tool.name.trim();
      if (names.has(normalizedName)) {
        runtime.degradedReasons.push(
          `Plugin tool "${normalizedName}" from ${pluginTools.pluginId} collides with existing tool name and was skipped`
        );
        continue;
      }
      names.add(normalizedName);
      merged.push(tool);
    }
  }

  if (!runtime.agentDefinition?.tools || runtime.agentDefinition.tools.length === 0) {
    return merged;
  }

  for (const agentTool of runtime.agentDefinition.tools) {
    const normalizedName = agentTool.name.trim();
    if (names.has(normalizedName)) {
      runtime.degradedReasons.push(
        `Agent tool "${normalizedName}" collides with existing tool name and was skipped`
      );
      continue;
    }
    names.add(normalizedName);
    merged.push(agentTool);
  }

  return merged;
}
