import { normalizeValidationIssues } from "./definition.js";
import type {
  ToolDefinition,
  ToolContext,
  ToolExecutionResult,
  ToolValidationError
} from "./types.js";

export function validateToolInput(
  tool: ToolDefinition,
  input: unknown
):
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: ToolValidationError;
    } {
  if (!tool.parameters) {
    return {
      ok: true,
      value: input
    };
  }

  const parsed = tool.parameters.safeParse(input);
  if (parsed.success) {
    return {
      ok: true,
      value: parsed.data
    };
  }

  const issues = normalizeValidationIssues(parsed.error);
  const fallbackMessage =
    parsed.error &&
    typeof parsed.error === "object" &&
    typeof (parsed.error as { message?: unknown }).message === "string"
      ? ((parsed.error as { message?: unknown }).message as string)
      : "Tool input validation failed";

  return {
    ok: false,
    error: {
      code: "validation_error",
      message: issues[0]?.message ?? fallbackMessage,
      issues
    }
  };
}

export async function executeToolDefinition(params: {
  tool: ToolDefinition;
  input: unknown;
  context: ToolContext;
}): Promise<ToolExecutionResult> {
  const validation = validateToolInput(params.tool, params.input);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error
    };
  }

  try {
    const output = await params.tool.execute(validation.value, params.context);
    return {
      ok: true,
      output
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "execution_error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}
