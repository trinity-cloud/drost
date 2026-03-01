import type {
  ToolDefinition,
  ToolDefinitionSpec,
  ToolParameterSchema,
  ToolValidationIssue
} from "./types.js";

export function isSchemaLike(value: unknown): value is ToolParameterSchema {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as { safeParse?: unknown }).safeParse === "function";
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: ToolDefinitionSpec<TInput, TOutput>
): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

export function asToolDefinition(value: unknown): ToolDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ToolDefinition>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return null;
  }
  if (typeof candidate.execute !== "function") {
    return null;
  }
  if (candidate.parameters !== undefined && !isSchemaLike(candidate.parameters)) {
    return null;
  }

  return {
    name: candidate.name.trim(),
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    parameters: candidate.parameters,
    execute: candidate.execute
  };
}

export function normalizeValidationIssues(error: unknown): ToolValidationIssue[] {
  if (!error || typeof error !== "object") {
    return [];
  }

  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return [];
  }

  const normalized: ToolValidationIssue[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueRecord = issue as {
      path?: unknown;
      message?: unknown;
      code?: unknown;
    };

    const pathParts = Array.isArray(issueRecord.path)
      ? issueRecord.path.map((part) => String(part))
      : [];
    normalized.push({
      path: pathParts.length > 0 ? pathParts.join(".") : "$",
      message: typeof issueRecord.message === "string" ? issueRecord.message : "Invalid value",
      code: typeof issueRecord.code === "string" ? issueRecord.code : undefined
    });
  }
  return normalized;
}
