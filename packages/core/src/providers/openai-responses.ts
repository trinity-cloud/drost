import type { NormalizedStreamEvent } from "../events.js";
import type { UsageSnapshot } from "../types.js";
import { postJsonStreamWithTimeout, postJsonWithTimeout, type SseEvent } from "./http.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function joinMessages(messages: ProviderTurnRequest["messages"]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
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

  async runTurn(request: ProviderTurnRequest): Promise<void> {
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

    const response = await postJsonStreamWithTimeout({
      url: responsesUrl(baseUrl),
      headers: {
        authorization: `Bearer ${bearerToken}`
      },
      body: {
        model: request.profile.model,
        input: joinMessages(request.messages),
        stream: true
      },
      timeoutMs: 60_000,
      signal: request.signal,
      onSseEvent: async (event) => {
        const payload = parseSseJson(event);
        if (!payload) {
          return;
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
  }
}
