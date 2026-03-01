import type { NormalizedStreamEvent } from "../events.js";
import { imageDataUrl } from "../input-images.js";
import type { ChatInputImage, UsageSnapshot } from "../types.js";
import { postJsonStreamWithTimeout, postJsonWithTimeout, type SseEvent } from "./http.js";
import {
  normalizeNativeToolCalls,
  parseNativeToolCallsMessage,
  parseToolResultMessage
} from "./tool-protocol.js";
import type {
  ProviderAdapter,
  ProviderNativeToolCall,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest,
  ProviderTurnResult
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function resolveResponsesRole(
  role: ProviderTurnRequest["messages"][number]["role"]
): "system" | "user" | "assistant" {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  return "user";
}

function findLastUserMessageIndex(messages: ProviderTurnRequest["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function resolveMessageImageRefs(
  request: ProviderTurnRequest,
  message: ProviderTurnRequest["messages"][number]
): ChatInputImage[] {
  if (typeof request.resolveInputImageRef !== "function") {
    return [];
  }
  const refs = message?.imageRefs ?? [];
  if (!Array.isArray(refs) || refs.length === 0) {
    return [];
  }
  const resolved: ChatInputImage[] = [];
  for (const ref of refs) {
    const image = request.resolveInputImageRef(ref);
    if (image) {
      resolved.push(image);
    }
  }
  return resolved;
}

function buildResponsesInput(request: ProviderTurnRequest): Array<Record<string, unknown>> {
  const messages = request.messages;
  const fallbackInputImages = request.inputImages ?? [];
  const lastUserIndex = findLastUserMessageIndex(messages);
  const input: Array<Record<string, unknown>> = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.role === "tool") {
      const nativeToolCalls = parseNativeToolCallsMessage(message.content);
      if (nativeToolCalls && nativeToolCalls.length > 0) {
        for (let callIndex = 0; callIndex < nativeToolCalls.length; callIndex += 1) {
          const nativeToolCall = nativeToolCalls[callIndex];
          if (!nativeToolCall) {
            continue;
          }
          const callId =
            nativeToolCall.id?.trim() ||
            `drost_call_${index + 1}_${callIndex + 1}`;
          input.push({
            type: "function_call",
            call_id: callId,
            name: nativeToolCall.name,
            arguments: safeJsonString(nativeToolCall.input ?? {})
          });
        }
        continue;
      }

      const toolResult = parseToolResultMessage(message.content);
      if (toolResult?.callId) {
        input.push({
          type: "function_call_output",
          call_id: toolResult.callId,
          output: safeJsonString({
            name: toolResult.name,
            ok: toolResult.ok,
            output: toolResult.output,
            error: toolResult.error
          })
        });
        continue;
      }
    }

    const persistedImages = resolveMessageImageRefs(request, message);
    const images =
      message.role === "user"
        ? persistedImages.length > 0
          ? persistedImages
          : index === lastUserIndex
            ? fallbackInputImages
            : []
        : [];
    const includeImages = images.length > 0;
    const normalizedText = message.content.trim();
    if (!includeImages && normalizedText.length === 0) {
      continue;
    }

    if (includeImages) {
      const contentParts: Array<Record<string, unknown>> = [];
      if (normalizedText.length > 0) {
        contentParts.push({
          type: "input_text",
          text: message.content
        });
      }
      for (const image of images) {
        contentParts.push({
          type: "input_image",
          detail: "auto",
          image_url: imageDataUrl(image)
        });
      }
      input.push({
        type: "message",
        role: resolveResponsesRole(message.role),
        content: contentParts
      });
      continue;
    }

    input.push({
      type: "message",
      role: resolveResponsesRole(message.role),
      content: message.content
    });
  }

  return input;
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function fallbackToolInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true
  };
}

function normalizeToolInputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallbackToolInputSchema();
  }
  return value as Record<string, unknown>;
}

function buildResponsesTools(request: ProviderTurnRequest): Array<Record<string, unknown>> {
  const tools = Array.isArray(request.availableTools) ? request.availableTools : [];
  if (tools.length === 0) {
    return [];
  }
  const resolved: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const name = tool?.name?.trim();
    if (!name) {
      continue;
    }
    resolved.push({
      type: "function",
      name,
      description: tool.description?.trim() || undefined,
      parameters: normalizeToolInputSchema(tool.inputSchema)
    });
  }
  return resolved;
}

function parseLooseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      value: trimmed
    };
  }
}

function isFunctionCallType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "function_call" ||
    normalized === "tool_call" ||
    normalized.endsWith(":function_call") ||
    normalized.endsWith(":tool_call")
  );
}

function toNativeToolCall(value: unknown): ProviderNativeToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isFunctionCallType(record.type)) {
    return null;
  }
  const functionRecord =
    record.function && typeof record.function === "object"
      ? (record.function as Record<string, unknown>)
      : null;
  const name = typeof record.name === "string"
    ? record.name.trim()
    : typeof functionRecord?.name === "string"
      ? functionRecord.name.trim()
      : "";
  if (!name) {
    return null;
  }
  const callIdCandidate = typeof record.call_id === "string"
    ? record.call_id.trim()
    : typeof record.id === "string"
      ? record.id.trim()
      : "";
  const argumentsValue = parseLooseJson(
    record.arguments ?? functionRecord?.arguments ?? functionRecord?.input ?? record.input
  );
  return {
    id: callIdCandidate.length > 0 ? callIdCandidate : undefined,
    name,
    input: argumentsValue ?? {}
  };
}

function extractNativeToolCallsFromResponsesPayload(payload: unknown): ProviderNativeToolCall[] {
  const calls: ProviderNativeToolCall[] = [];
  const collectFromRecord = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    const fromRecord = toNativeToolCall(record);
    if (fromRecord) {
      calls.push(fromRecord);
    }
    if (Array.isArray(record.output)) {
      for (const item of record.output) {
        const fromItem = toNativeToolCall(item);
        if (fromItem) {
          calls.push(fromItem);
        }
      }
    }
    if (record.item && typeof record.item === "object") {
      const fromItem = toNativeToolCall(record.item);
      if (fromItem) {
        calls.push(fromItem);
      }
    }
    if (record.response && typeof record.response === "object") {
      collectFromRecord(record.response);
    }
  };
  collectFromRecord(payload);
  return normalizeNativeToolCalls(calls);
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;

  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  const output = record.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const segment of content) {
      if (!segment || typeof segment !== "object") {
        continue;
      }
      const text = (segment as Record<string, unknown>).text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  return chunks.join("");
}

function extractUsage(payload: unknown): UsageSnapshot | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined;
  const outputTokens =
    typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined;
  const totalTokens =
    typeof usageRecord.total_tokens === "number" ? usageRecord.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function extractUsageFromStreamRecord(record: Record<string, unknown>): UsageSnapshot | undefined {
  const response = record.response;
  if (response && typeof response === "object") {
    const responseUsage = extractUsage(response);
    if (responseUsage) {
      return responseUsage;
    }
  }
  return extractUsage(record);
}

function providerErrorEvent(params: {
  sessionId: string;
  providerId: string;
  message: string;
}): NormalizedStreamEvent {
  return {
    type: "provider.error",
    sessionId: params.sessionId,
    providerId: params.providerId,
    timestamp: nowIso(),
    payload: {
      error: params.message
    }
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function responsesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? `${normalized}/responses` : `${normalized}/v1/responses`;
}

function parseSseJson(event: SseEvent): Record<string, unknown> | null {
  if (!event.data || event.data === "[DONE]") {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function streamErrorMessage(record: Record<string, unknown>): string | null {
  const directError = record.error;
  if (typeof directError === "string" && directError.trim().length > 0) {
    return directError.trim();
  }
  if (directError && typeof directError === "object") {
    const message = (directError as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  if (record.message && typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  return null;
}

async function runProbe(params: {
  profile: ProviderProfile;
  context: ProviderProbeContext;
  bearerToken: string;
}): Promise<ProviderProbeResult> {
  const baseUrl = params.profile.baseUrl?.trim();
  if (!baseUrl) {
    return {
      providerId: params.profile.id,
      ok: false,
      code: "provider_error",
      message: "Missing baseUrl for OpenAI Responses provider"
    };
  }

  try {
    const response = await postJsonWithTimeout({
      url: responsesUrl(baseUrl),
      headers: {
        authorization: `Bearer ${params.bearerToken}`
      },
      body: {
        model: params.profile.model,
        input: "drost startup probe",
        max_output_tokens: 1
      },
      timeoutMs: params.context.timeoutMs
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        providerId: params.profile.id,
        ok: true,
        code: "ok",
        message: "Responses API probe succeeded"
      };
    }

    if (response.status === 404 || response.status === 405) {
      return {
        providerId: params.profile.id,
        ok: false,
        code: "incompatible_transport",
        message: `Endpoint does not expose /v1/responses (status ${response.status})`
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        providerId: params.profile.id,
        ok: false,
        code: "missing_auth",
        message: `Responses API auth rejected (status ${response.status})`
      };
    }

    if (response.status >= 400 && response.status < 500) {
      return {
        providerId: params.profile.id,
        ok: true,
        code: "ok",
        message: `Responses API endpoint reachable (status ${response.status})`
      };
    }

    return {
      providerId: params.profile.id,
      ok: false,
      code: "unreachable",
      message: `Responses API probe failed (status ${response.status})`
    };
  } catch (error) {
    return {
      providerId: params.profile.id,
      ok: false,
      code: "unreachable",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly id = "openai-responses";
  readonly supportsNativeToolCalls = true;

  async probe(profile: ProviderProfile, context: ProviderProbeContext): Promise<ProviderProbeResult> {
    const bearerToken = context.resolveBearerToken(profile.authProfileId);
    if (!bearerToken) {
      return {
        providerId: profile.id,
        ok: false,
        code: "missing_auth",
        message: `Missing auth profile token: ${profile.authProfileId}`
      };
    }

    return await runProbe({
      profile,
      context,
      bearerToken
    });
  }

  async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const bearerToken = request.resolveBearerToken(request.profile.authProfileId);
    if (!bearerToken) {
      const message = `Missing auth profile token: ${request.profile.authProfileId}`;
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(message);
    }

    const baseUrl = request.profile.baseUrl?.trim();
    if (!baseUrl) {
      const message = "Missing baseUrl for OpenAI Responses provider";
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(message);
    }

    let responseText = "";
    let usage: UsageSnapshot | undefined;
    let streamError: string | null = null;
    let nativeToolCalls: ProviderNativeToolCall[] = [];
    const nativeTools = buildResponsesTools(request);

    const runAttempt = async (withNativeTools: boolean) => {
      responseText = "";
      usage = undefined;
      streamError = null;
      nativeToolCalls = [];

      const body: Record<string, unknown> = {
        model: request.profile.model,
        input: buildResponsesInput(request),
        stream: true
      };
      if (withNativeTools && nativeTools.length > 0) {
        body.tools = nativeTools;
        body.tool_choice = "auto";
      }

      return await postJsonStreamWithTimeout({
        url: responsesUrl(baseUrl),
        headers: {
          authorization: `Bearer ${bearerToken}`
        },
        body,
        timeoutMs: 60_000,
        signal: request.signal,
        onSseEvent: async (event) => {
          const payload = parseSseJson(event);
          if (!payload) {
            return;
          }

          const streamCalls = extractNativeToolCallsFromResponsesPayload(payload);
          if (streamCalls.length > 0) {
            nativeToolCalls = normalizeNativeToolCalls([...nativeToolCalls, ...streamCalls]);
          }

          const streamType = typeof payload.type === "string" ? payload.type : "";
          if (streamType === "response.error" || streamType === "error") {
            streamError = streamErrorMessage(payload) ?? "Responses stream error";
            return;
          }

          if (streamType === "response.output_text.delta") {
            const delta = typeof payload.delta === "string" ? payload.delta : "";
            if (delta.length > 0) {
              responseText += delta;
              request.emit({
                type: "response.delta",
                sessionId: request.sessionId,
                providerId: request.providerId,
                timestamp: nowIso(),
                payload: {
                  text: delta
                }
              });
            }
            return;
          }

          if (streamType === "response.completed") {
            usage = extractUsageFromStreamRecord(payload) ?? usage;
          }
        }
      });
    };

    let response = await runAttempt(true);
    if (
      response.status === 400 &&
      nativeTools.length > 0 &&
      response.text.toLowerCase().includes("tool")
    ) {
      response = await runAttempt(false);
    }

    if (response.status >= 400) {
      const message = `Responses API request failed (status ${response.status})`;
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(`${message}: ${response.text}`);
    }

    if (!response.streamed) {
      responseText = extractResponseText(response.json);
      usage = extractUsage(response.json);
      const responseCalls = extractNativeToolCallsFromResponsesPayload(response.json);
      if (responseCalls.length > 0) {
        nativeToolCalls = normalizeNativeToolCalls([...nativeToolCalls, ...responseCalls]);
      }
      if (responseText.length > 0) {
        request.emit({
          type: "response.delta",
          sessionId: request.sessionId,
          providerId: request.providerId,
          timestamp: nowIso(),
          payload: {
            text: responseText
          }
        });
      }
    }

    if (streamError) {
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message: streamError
      }));
      throw new Error(streamError);
    }

    if (usage) {
      request.emit({
        type: "usage.updated",
        sessionId: request.sessionId,
        providerId: request.providerId,
        timestamp: nowIso(),
        payload: {
          usage
        }
      });
    }

    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: nowIso(),
      payload: {
        text: responseText,
        usage
      }
    });
    return {
      nativeToolCalls
    };
  }
}
