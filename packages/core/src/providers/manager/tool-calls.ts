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

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function parseXmlAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = attributePattern.exec(text);
  while (match) {
    const key = (match[1] ?? "").trim().toLowerCase();
    const rawValue = match[3] ?? match[4] ?? "";
    if (key) {
      attributes[key] = decodeXmlEntities(rawValue.trim());
    }
    match = attributePattern.exec(text);
  }
  return attributes;
}

function findToolNameFromAttributes(attributes: Record<string, string>): string {
  const keys = ["name", "tool", "tool_name", "function", "function_name"];
  for (const key of keys) {
    const value = attributes[key]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function parseStructuredParamValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function inferToolNameFromInput(
  availableToolNames: string[],
  input: Record<string, unknown>
): string {
  if (availableToolNames.length === 1) {
    return availableToolNames[0] ?? "";
  }

  const action =
    typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
  if (action) {
    if ((action === "search" || action === "fetch") && availableToolNames.includes("web")) {
      return "web";
    }
    if (
      (action === "read" || action === "write" || action === "list" || action === "edit") &&
      availableToolNames.includes("file")
    ) {
      return "file";
    }
    if ((action === "status" || action === "restart") && availableToolNames.includes("agent")) {
      return "agent";
    }
    const exactActionMatch = availableToolNames.find(
      (name) => name.toLowerCase() === action
    );
    if (exactActionMatch) {
      return exactActionMatch;
    }
    const containsActionMatch = availableToolNames.find((name) =>
      name.toLowerCase().includes(action)
    );
    if (containsActionMatch) {
      return containsActionMatch;
    }
  }

  const hasQuery = typeof input.query === "string" && input.query.trim().length > 0;
  if (hasQuery) {
    const searchMatch = availableToolNames.find((name) =>
      name.toLowerCase().includes("search")
    );
    if (searchMatch) {
      return searchMatch;
    }
  }

  return "";
}

function normalizeResolvedToolName(
  toolName: string,
  availableToolNames: string[]
): string {
  const trimmed = toolName.trim();
  if (!trimmed) {
    return "";
  }
  if (availableToolNames.includes(trimmed)) {
    return trimmed;
  }
  const lowered = trimmed.toLowerCase();
  const aliasToCanonical: Record<string, string> = {
    "web_search": "web",
    "web.fetch": "web",
    "web.search": "web",
    "web_fetch": "web",
    "file_read": "file",
    "file_write": "file",
    "file_edit": "file",
    "file_list": "file",
    "agent_status": "agent"
  };
  const aliased = aliasToCanonical[lowered];
  if (aliased && availableToolNames.includes(aliased)) {
    return aliased;
  }
  return trimmed;
}

function parseXaiXmlToolCall(
  text: string,
  availableToolNames: string[]
): { toolName: string; input: unknown } | null {
  const callPattern =
    /<\s*(?:xai:)?(?:function_call|tool_call)\b([^>]*)>([\s\S]*?)<\/\s*(?:xai:)?(?:function_call|tool_call)\s*>/i;
  const callMatch = callPattern.exec(text);
  if (!callMatch) {
    return null;
  }

  const openingAttributes = parseXmlAttributes(callMatch[1] ?? "");
  const body = callMatch[2] ?? "";
  const parameterPattern = /<\s*parameter\b([^>]*)>([\s\S]*?)<\/\s*parameter\s*>/gi;
  const input: Record<string, unknown> = {};
  let toolName = findToolNameFromAttributes(openingAttributes);

  let parameterMatch = parameterPattern.exec(body);
  while (parameterMatch) {
    const parameterAttributes = parseXmlAttributes(parameterMatch[1] ?? "");
    const key =
      parameterAttributes.name?.trim() ||
      parameterAttributes.key?.trim() ||
      parameterAttributes.param?.trim() ||
      "";
    if (key) {
      const value = decodeXmlEntities((parameterMatch[2] ?? "").trim());
      input[key] = parseStructuredParamValue(value);
    }
    parameterMatch = parameterPattern.exec(body);
  }

  if (!toolName && typeof input.name === "string") {
    toolName = input.name.trim();
    delete input.name;
  }
  if (!toolName && typeof input.tool === "string") {
    toolName = input.tool.trim();
    delete input.tool;
  }

  if (!toolName) {
    toolName = inferToolNameFromInput(availableToolNames, input);
  }
  toolName = normalizeResolvedToolName(toolName, availableToolNames);

  if (!toolName) {
    return null;
  }

  return {
    toolName,
    input
  };
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

export function parseToolCall(
  text: string,
  availableToolNames?: string[]
): { toolName: string; input: unknown } | null {
  const trimmed = text.trim();
  const normalizedAvailableToolNames = (availableToolNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const xmlToolCall = parseXaiXmlToolCall(trimmed, normalizedAvailableToolNames);
  if (xmlToolCall) {
    return xmlToolCall;
  }

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
