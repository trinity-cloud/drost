import type { ChatMessage } from "../../types.js";
import { nowIso } from "./metadata.js";

export function normalizeToolNames(toolNames: string[] | undefined): string[] {
  if (!toolNames) {
    return [];
  }
  return Array.from(
    new Set(
      toolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function createToolInstructionMessage(toolNames: string[]): ChatMessage | null {
  if (toolNames.length === 0) {
    return null;
  }
  return {
    role: "system",
    content: [
      "Tool calling is available for this session.",
      `Available tools: ${toolNames.join(", ")}`,
      "If native tool calling is unavailable, respond with exactly one line in this format and no additional text:",
      "TOOL_CALL {\"name\":\"<tool_name>\",\"input\":{...}}",
      "After you receive TOOL_RESULT as a tool message, continue with the user response."
    ].join("\n"),
    createdAt: nowIso()
  };
}

export function buildTurnMessages(history: ChatMessage[], toolNames: string[]): ChatMessage[] {
  const instruction = createToolInstructionMessage(toolNames);
  if (!instruction) {
    return [...history];
  }
  return [instruction, ...history];
}

function unwrapFencedJson(jsonText: string): string {
  const trimmed = jsonText.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 3) {
    return trimmed;
  }
  const first = lines[0]?.trim() ?? "";
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!first.startsWith("```") || !last.startsWith("```")) {
    return trimmed;
  }
  return lines.slice(1, -1).join("\n").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function extractToolCallJson(text: string): string | null {
  const markerIndex = text.indexOf("TOOL_CALL");
  if (markerIndex < 0) {
    return null;
  }

  const afterMarker = text.slice(markerIndex + "TOOL_CALL".length).trim();
  if (!afterMarker) {
    return null;
  }

  const unwrapped = unwrapFencedJson(afterMarker);
  return extractFirstJsonObject(unwrapped) ?? extractFirstJsonObject(afterMarker);
}

export function parseToolCall(text: string): { toolName: string; input: unknown } | null {
  const trimmed = text.trim();
  if (!trimmed.includes("TOOL_CALL")) {
    return null;
  }

  const jsonPart = extractToolCallJson(trimmed);
  if (!jsonPart) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolName =
    typeof record.name === "string"
      ? record.name.trim()
      : typeof record.tool === "string"
        ? record.tool.trim()
        : "";
  if (!toolName) {
    return null;
  }
  return {
    toolName,
    input: record.input ?? record.arguments ?? {}
  };
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
