import type { StreamEventHandler } from "../../events.js";
import { executeToolDefinition, type ToolExecutionResult } from "../../tools.js";
import { nowIso, safeJsonStringify } from "../helpers.js";
import type { ToolRunResult } from "../../gateway.js";
import { isToolAllowed, resolveToolProviderId } from "./policy.js";

export async function runTool(
  runtime: any,
  params: {
    sessionId: string;
    toolName: string;
    input: unknown;
    providerId?: string;
    onEvent?: StreamEventHandler;
  }
): Promise<ToolRunResult> {
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

  const tool = runtime.toolRegistry.get(toolName);
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

  const providerId = resolveToolProviderId(runtime, params.sessionId, params.providerId);
  const policyCheck = isToolAllowed(runtime, toolName);
  if (!policyCheck.allowed) {
    const deniedReason = policyCheck.reason ?? `Tool "${toolName}" denied by policy`;
    runtime.emitRuntimeEvent("tool.policy.denied", {
      sessionId: params.sessionId,
      toolName,
      reason: deniedReason
    });
    runtime.appendSessionEvent(params.sessionId, "tool.policy.denied", {
      toolName,
      reason: deniedReason
    });
    runtime.appendObservabilityRecord(
      "usage-events",
      {
        kind: "tool.policy.denied",
        sessionId: params.sessionId,
        toolName,
        reason: deniedReason
      },
      runtime.config.observability?.usageEventsEnabled
    );
    await runtime.pluginRuntime?.runOnToolResult({
      sessionId: params.sessionId,
      providerId,
      toolName,
      input: params.input,
      result: {
        ok: false,
        error: {
          code: "policy_denied",
          message: deniedReason
        }
      }
    });
    return {
      toolName,
      ok: false,
      error: {
        code: "policy_denied",
        message: deniedReason
      }
    };
  }

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
  runtime.appendSessionEvent(params.sessionId, "tool.call.started", {
    providerId,
    toolName,
    input: params.input
  });
  runtime.appendObservabilityRecord(
    "tool-traces",
    {
      phase: "started",
      sessionId: params.sessionId,
      providerId,
      toolName,
      input: params.input
    },
    runtime.config.observability?.toolTracesEnabled
  );

  const startedAt = Date.now();
  const result: ToolExecutionResult = await executeToolDefinition({
    tool,
    input: params.input,
    context: {
      workspaceDir: runtime.workspaceDir,
      mutableRoots: runtime.mutableRoots,
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
    runtime.appendSessionEvent(params.sessionId, "tool.call.completed", {
      providerId,
      toolName,
      ok: false,
      code: result.error?.code ?? "execution_error",
      message: result.error?.message ?? "Tool execution failed",
      durationMs: Date.now() - startedAt
    });
    runtime.appendObservabilityRecord(
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
      runtime.config.observability?.toolTracesEnabled
    );

    if (result.error?.code === "validation_error") {
      await runtime.pluginRuntime?.runOnToolResult({
        sessionId: params.sessionId,
        providerId,
        toolName,
        input: params.input,
        result: {
          ok: false,
          error: {
            code: "validation_error",
            message: result.error.message
          }
        }
      });
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

    await runtime.pluginRuntime?.runOnToolResult({
      sessionId: params.sessionId,
      providerId,
      toolName,
      input: params.input,
      result: {
        ok: false,
        error: {
          code: result.error?.code ?? "execution_error",
          message: result.error?.message ?? "Tool execution failed"
        }
      }
    });
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
  runtime.appendSessionEvent(params.sessionId, "tool.call.completed", {
    providerId,
    toolName,
    ok: true,
    output: result.output,
    durationMs: Date.now() - startedAt
  });
  runtime.appendObservabilityRecord(
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
    runtime.config.observability?.toolTracesEnabled
  );
  await runtime.pluginRuntime?.runOnToolResult({
    sessionId: params.sessionId,
    providerId,
    toolName,
    input: params.input,
    result: {
      ok: true,
      output: result.output
    }
  });

  return {
    toolName,
    ok: true,
    output: result.output
  };
}
