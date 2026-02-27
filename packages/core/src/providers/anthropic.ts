import type { NormalizedStreamEvent } from "../events.js";
import type { ChatMessage, UsageSnapshot } from "../types.js";
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

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14"
] as const;

function isAnthropicOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

function buildAnthropicHeaders(token: string): Record<string, string> {
  if (isAnthropicOAuthToken(token)) {
    return {
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETAS.join(",")
    };
  }
  return {
    "x-api-key": token,
    "anthropic-version": ANTHROPIC_VERSION
  };
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

function mapMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") {
      chunks.push(text);
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

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined
  };
}

function usageFromMessageStart(record: Record<string, unknown>): UsageSnapshot | undefined {
  const message = record.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined;
  const outputTokens =
    typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0)
  };
}

function usageFromMessageDelta(record: Record<string, unknown>, prior: UsageSnapshot | undefined): UsageSnapshot | undefined {
  const usage = record.usage;
  if (!usage || typeof usage !== "object") {
    return prior;
  }
  const usageRecord = usage as Record<string, unknown>;
  const outputTokens =
    typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : prior?.outputTokens;
  const inputTokens = prior?.inputTokens;
  if (inputTokens === undefined && outputTokens === undefined) {
    return prior;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0)
  };
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
  const error = record.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  const message = record.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }
  return null;
}

function sameUsage(left: UsageSnapshot | undefined, right: UsageSnapshot | undefined): boolean {
  return (
    left?.inputTokens === right?.inputTokens &&
    left?.outputTokens === right?.outputTokens &&
    left?.totalTokens === right?.totalTokens
  );
}

async function runProbe(params: {
  profile: ProviderProfile;
  context: ProviderProbeContext;
  bearerToken: string;
}): Promise<ProviderProbeResult> {
  const baseUrl = params.profile.baseUrl?.trim() || "https://api.anthropic.com";

  try {
    const response = await postJsonWithTimeout({
      url: `${normalizeBaseUrl(baseUrl)}/v1/messages`,
      headers: buildAnthropicHeaders(params.bearerToken),
      body: {
        model: params.profile.model,
        messages: [{ role: "user", content: "drost startup probe" }],
        max_tokens: 1
      },
      timeoutMs: params.context.timeoutMs
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        providerId: params.profile.id,
        ok: true,
        code: "ok",
        message: "Anthropic Messages API probe succeeded"
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        providerId: params.profile.id,
        ok: false,
        code: "missing_auth",
        message: `Anthropic auth rejected (status ${response.status})`
      };
    }

    if (response.status === 404 || response.status === 405) {
      return {
        providerId: params.profile.id,
        ok: false,
        code: "incompatible_transport",
        message: `Anthropic endpoint unavailable (status ${response.status})`
      };
    }

    if (response.status >= 400 && response.status < 500) {
      return {
        providerId: params.profile.id,
        ok: true,
        code: "ok",
        message: `Anthropic endpoint reachable (status ${response.status})`
      };
    }

    return {
      providerId: params.profile.id,
      ok: false,
      code: "unreachable",
      message: `Anthropic probe failed (status ${response.status})`
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

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly id = "anthropic-messages";

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

    const baseUrl = request.profile.baseUrl?.trim() || "https://api.anthropic.com";
    let responseText = "";
    let usage: UsageSnapshot | undefined;
    let streamError: string | null = null;

    const response = await postJsonStreamWithTimeout({
      url: `${normalizeBaseUrl(baseUrl)}/v1/messages`,
      headers: buildAnthropicHeaders(bearerToken),
      body: {
        model: request.profile.model,
        messages: mapMessages(request.messages),
        max_tokens: 1024,
        stream: true
      },
      timeoutMs: 60_000,
      signal: request.signal,
      onSseEvent: async (event) => {
        const payload = parseSseJson(event);
        if (!payload) {
          return;
        }

        const streamType = typeof payload.type === "string" ? payload.type : event.event;
        if (streamType === "error") {
          streamError = streamErrorMessage(payload) ?? "Anthropic stream error";
          return;
        }

        if (streamType === "content_block_delta") {
          const delta = payload.delta;
          if (!delta || typeof delta !== "object") {
            return;
          }
          const text = (delta as Record<string, unknown>).text;
          if (typeof text === "string" && text.length > 0) {
            responseText += text;
            request.emit({
              type: "response.delta",
              sessionId: request.sessionId,
              providerId: request.providerId,
              timestamp: nowIso(),
              payload: {
                text
              }
            });
          }
          return;
        }

        if (streamType === "message_start") {
          const nextUsage = usageFromMessageStart(payload) ?? usage;
          if (!sameUsage(usage, nextUsage) && nextUsage) {
            usage = nextUsage;
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
          return;
        }

        if (streamType === "message_delta") {
          const nextUsage = usageFromMessageDelta(payload, usage);
          if (!sameUsage(usage, nextUsage) && nextUsage) {
            usage = nextUsage;
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
        }
      }
    });

    if (response.status >= 400) {
      const message = `Anthropic messages request failed (status ${response.status})`;
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(`${message}: ${response.text}`);
    }

    if (!response.streamed) {
      responseText = extractText(response.json);
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
    }

    if (streamError) {
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message: streamError
      }));
      throw new Error(streamError);
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
