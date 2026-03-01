import type { StreamEventHandler } from "../../events.js";

export async function runSessionTurn(
  runtime: any,
  params: {
    sessionId: string;
    input: string;
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

  const onEvent: StreamEventHandler = (event) => {
    if (event.type !== "tool.call.started" && event.type !== "tool.call.completed") {
      runtime.appendSessionEvent(params.sessionId, event.type, {
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
      authStore: runtime.authStore,
      route: routeSelection ?? undefined,
      onEvent,
      signal: params.signal,
      availableToolNames: runtime.listLoadedToolNames(),
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
          outputChars: assistantText ? assistantText.length : 0,
          historyBeforeCount,
          historyAfterCount: history.length,
          skillInjectionMode: skillInjection.mode,
          skillsInjected: skillInjection.skillIds
        },
        runtime.config.observability?.usageEventsEnabled
      );
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
