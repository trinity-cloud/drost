import { createEvolutionTransactionId, nowIso } from "../helpers.js";
import type {
  GatewayEvolutionRunRequest,
  GatewayEvolutionRunResult,
  GatewayEvolutionTransactionState,
  GatewayRestartResult,
  ToolRunResult
} from "../../gateway.js";

export async function runEvolution(runtime: any, params: GatewayEvolutionRunRequest): Promise<GatewayEvolutionRunResult> {
  const evolutionEnabled = runtime.config.evolution?.enabled ?? true;
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

  const active = runtime.activeEvolutionTransaction;
  if (active) {
    runtime.emitRuntimeEvent("evolution.busy", {
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
  runtime.activeEvolutionTransaction = transaction;
  runtime.emitRuntimeEvent("evolution.requested", {
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
        runtime.emitRuntimeEvent("evolution.step.failed", {
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
        runtime.emitRuntimeEvent("evolution.step.failed", {
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

      const toolResult = await runtime.runTool({
        sessionId,
        toolName,
        input: step.input,
        providerId: step.providerId ?? params.providerId,
        onEvent: params.onEvent
      });
      stepResults.push(toolResult);
      if (!toolResult.ok) {
        runtime.emitRuntimeEvent("evolution.step.failed", {
          transactionId: transaction.transactionId,
          stepIndex: index,
          toolName,
          message: toolResult.error?.message ?? "unknown tool failure"
        });
        runtime.emitRuntimeEvent("evolution.failed", {
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
      runtime.emitRuntimeEvent("evolution.step.completed", {
        transactionId: transaction.transactionId,
        stepIndex: index,
        toolName
      });
    }

    let restartResult: GatewayRestartResult | undefined;
    if (params.requestRestart) {
      const restartResponse = await runtime.requestRestart({
        intent: "self_mod",
        reason: transaction.summary ?? `evolution transaction ${transaction.transactionId}`,
        sessionId,
        providerId: params.providerId,
        dryRun: params.restartDryRun ?? false
      });
      if (restartResponse && typeof restartResponse === "object" && "ok" in restartResponse) {
        const parsedRestart = restartResponse as GatewayRestartResult;
        restartResult = parsedRestart;
        if (!parsedRestart.ok) {
          runtime.emitRuntimeEvent("evolution.failed", {
            transactionId: transaction.transactionId,
            failedStepIndex: stepResults.length - 1,
            restartCode: parsedRestart.code
          });
          return {
            ok: false,
            code: "failed",
            message: `Evolution restart blocked: ${parsedRestart.message}`,
            transactionId: transaction.transactionId,
            failedStepIndex: stepResults.length - 1,
            stepsAttempted: stepResults.length,
            stepResults,
            restart: parsedRestart
          };
        }
      }
    }

    runtime.emitRuntimeEvent("evolution.completed", {
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
    runtime.activeEvolutionTransaction = null;
  }
}
