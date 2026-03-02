import type { StreamEventHandler } from "../../events.js";
import { persistSessionInputImages, resolveInputImageFromRef } from "../../media-store.js";
import type { ProviderNativeToolDefinition } from "../../providers/types.js";
import { toolInputSchemaFromParameters } from "../../tools/json-schema.js";
import type { ChatImageRef, ChatInputImage } from "../../types.js";

function sanitizePreview(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function resolveProviderNativeTools(runtime: any, toolNames: string[]): ProviderNativeToolDefinition[] {
  if (toolNames.length === 0) {
    return [];
  }
  const nativeTools: ProviderNativeToolDefinition[] = [];
  for (const toolName of toolNames) {
    const tool = runtime.toolRegistry.get(toolName);
    if (!tool) {
      continue;
    }
    nativeTools.push({
      name: toolName,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: toolInputSchemaFromParameters(tool.parameters)
    });
  }
  return nativeTools;
}

export async function runSessionTurn(
  runtime: any,
  params: {
    sessionId: string;
    input: string;
    inputImages?: ChatInputImage[];
    onEvent: StreamEventHandler;
    signal?: AbortSignal;
  }
): Promise<void> {
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    throw new Error("No provider manager configured");
  }

  const turnStartedAtMs = Date.now();
  const historyBeforeCount = manager.getSessionHistory(params.sessionId).length;
  const session = manager.getSession(params.sessionId);
  const activeProviderId = session?.activeProviderId;
  const pendingProviderId = session?.pendingProviderId;
  const runtimeContext = runtime.runtimeContext();
  let input = params.input;

  input =
    (await runtime.pluginRuntime?.runBeforeTurn({
      sessionId: params.sessionId,
      input,
      providerId: activeProviderId
    })) ?? input;
  if (runtime.agentDefinition?.hooks?.beforeTurn) {
    const hookResult = await runtime.agentDefinition.hooks.beforeTurn({
      sessionId: params.sessionId,
      input,
      providerId: activeProviderId,
      runtime: runtimeContext
    });
    if (hookResult && typeof hookResult.input === "string") {
      input = hookResult.input;
    }
  }

  const skillInjection = runtime.applySkillInjection(params.sessionId, input);
  input = skillInjection.input;
  if (skillInjection.skillIds.length > 0) {
    runtime.appendSessionEvent(params.sessionId, "skills.injected", {
      mode: skillInjection.mode,
      skills: skillInjection.skillIds
    });
  }

  let runSucceeded = false;
  const routeSelection = runtime.resolveProviderRouteSelection(params.sessionId);
  if (routeSelection?.routeId) {
    manager.updateSessionMetadata(params.sessionId, {
      providerRouteId: routeSelection.routeId
    });
  }

  runtime.emitRuntimeEvent("session.turn.started", {
    sessionId: params.sessionId,
    providerId: routeSelection?.primaryProviderId ?? pendingProviderId ?? activeProviderId ?? "unknown",
    activeProviderId,
    pendingProviderId,
    routeId: routeSelection?.routeId,
    inputChars: input.length,
    inputPreview: sanitizePreview(input),
    inputImageCount: params.inputImages?.length ?? 0,
    historyBeforeCount
  });

  const onEvent: StreamEventHandler = (event) => {
    if (event.type !== "tool.call.started" && event.type !== "tool.call.completed") {
      runtime.appendSessionEvent(params.sessionId, event.type, {
        providerId: event.providerId,
        payload: event.payload
      });
    }

    if (event.type === "provider.error") {
      runtime.emitRuntimeEvent("provider.error", {
        sessionId: event.sessionId,
        providerId: event.providerId,
        error: event.payload.error
      });
    } else if (event.type === "response.completed") {
      runtime.emitRuntimeEvent("provider.response.completed", {
        sessionId: event.sessionId,
        providerId: event.providerId,
        outputChars: typeof event.payload.text === "string" ? event.payload.text.length : 0,
        usage: event.payload.usage
      });
    } else if (event.type === "tool.call.started") {
      runtime.emitRuntimeEvent("tool.call.started", {
        sessionId: event.sessionId,
        providerId: event.providerId,
        toolName: event.payload.toolName,
        input: event.payload.metadata?.input
      });
    } else if (event.type === "tool.call.completed") {
      runtime.emitRuntimeEvent("tool.call.completed", {
        sessionId: event.sessionId,
        providerId: event.providerId,
        toolName: event.payload.toolName,
        ok: event.payload.metadata?.ok,
        code: event.payload.metadata?.code,
        durationMs: event.payload.metadata?.durationMs,
        error: event.payload.error
      });
    }

    params.onEvent(event);
  };

  let persistedInputImageRefs: ChatImageRef[] = [];
  if (Array.isArray(params.inputImages) && params.inputImages.length > 0) {
    try {
      persistedInputImageRefs = persistSessionInputImages({
        workspaceDir: runtime.workspaceDir,
        sessionId: params.sessionId,
        images: params.inputImages,
        source: "session_turn"
      });
      runtime.appendSessionEvent(params.sessionId, "session.media.attached", {
        count: persistedInputImageRefs.length,
        images: persistedInputImageRefs
      });
    } catch (error) {
      runtime.appendSessionEvent(params.sessionId, "session.media.attach_failed", {
        count: params.inputImages.length,
        error: error instanceof Error ? error.message : String(error)
      });
      runtime.degradedReasons.push(
        `Failed to persist input images for ${params.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      runtime.state = "degraded";
    }
  }

  try {
    const availableToolNames = runtime.listLoadedToolNames();
    const availableTools = resolveProviderNativeTools(runtime, availableToolNames);
    await manager.runTurn({
      sessionId: params.sessionId,
      input,
      inputImages: params.inputImages,
      inputImageRefs: persistedInputImageRefs,
      resolveInputImageRef: (ref: ChatImageRef) =>
        resolveInputImageFromRef({
          workspaceDir: runtime.workspaceDir,
          ref
        }),
      authStore: runtime.authStore,
      route: routeSelection ?? undefined,
      onEvent,
      signal: params.signal,
      availableToolNames,
      availableTools,
      runTool: async (request: {
        sessionId: string;
        toolName: string;
        input: unknown;
        providerId?: string;
        onEvent?: StreamEventHandler;
      }) =>
        runtime.runTool({
          sessionId: request.sessionId,
          toolName: request.toolName,
          input: request.input,
          providerId: request.providerId,
          onEvent: request.onEvent
        })
    });
    runSucceeded = true;
  } catch (error) {
    runtime.emitRuntimeEvent("session.turn.failed", {
      sessionId: params.sessionId,
      providerId: runtime.getSessionState(params.sessionId)?.activeProviderId ?? activeProviderId ?? "unknown",
      durationMs: Date.now() - turnStartedAtMs,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    if (runSucceeded) {
      const history = manager.getSessionHistory(params.sessionId);
      const assistantText = history
        .filter((message: { role: string; content: string }) => message.role === "assistant")
        .at(-1)?.content;
      runtime.appendObservabilityRecord(
        "usage-events",
        {
          kind: "session.turn",
          sessionId: params.sessionId,
          providerId: runtime.getSessionState(params.sessionId)?.activeProviderId ?? activeProviderId ?? "unknown",
          durationMs: Date.now() - turnStartedAtMs,
          inputChars: input.length,
          inputImageCount: params.inputImages?.length ?? 0,
          outputChars: assistantText ? assistantText.length : 0,
          historyBeforeCount,
          historyAfterCount: history.length,
          skillInjectionMode: skillInjection.mode,
          skillsInjected: skillInjection.skillIds
        },
        runtime.config.observability?.usageEventsEnabled
      );
      runtime.emitRuntimeEvent("session.turn.completed", {
        sessionId: params.sessionId,
        providerId: runtime.getSessionState(params.sessionId)?.activeProviderId ?? activeProviderId ?? "unknown",
        durationMs: Date.now() - turnStartedAtMs,
        inputChars: input.length,
        outputChars: assistantText ? assistantText.length : 0,
        historyBeforeCount,
        historyAfterCount: history.length,
        inputImageCount: params.inputImages?.length ?? 0
      });
    }
    if (runSucceeded && runtime.agentDefinition?.hooks?.afterTurn) {
      try {
        await runtime.agentDefinition.hooks.afterTurn({
          sessionId: params.sessionId,
          input,
          providerId: activeProviderId,
          runtime: runtimeContext,
          output: {
            historyCount: manager.getSessionHistory(params.sessionId).length
          }
        });
      } catch (error) {
        runtime.degradedReasons.push(
          `Agent afterTurn hook failed: ${error instanceof Error ? error.message : String(error)}`
        );
        runtime.state = "degraded";
      }
    }
    if (runSucceeded && runtime.pluginRuntime) {
      const history = manager.getSessionHistory(params.sessionId);
      const assistantResponse = history
        .filter((message: { role: string; content: string }) => message.role === "assistant")
        .at(-1)?.content;
      await runtime.pluginRuntime.runAfterTurn({
        sessionId: params.sessionId,
        input,
        providerId: runtime.getSessionState(params.sessionId)?.activeProviderId ?? activeProviderId,
        output: {
          historyCount: history.length,
          response: assistantResponse
        }
      });
    }
    runtime.persistSessionState(params.sessionId);
  }
}
