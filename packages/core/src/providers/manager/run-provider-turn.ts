import type { AuthStore } from "../../auth/store.js";
import type { StreamEventHandler } from "../../events.js";
import type { ChatImageRef, ChatInputImage, ChatMessage } from "../../types.js";
import type { ProviderAdapter, ProviderProfile } from "../types.js";
import { classifyProviderFailure } from "./failure.js";
import { ProviderFailoverState } from "./failover.js";
import { resolveProviderBearerToken } from "./auth-resolution.js";
import { nowIso } from "./metadata.js";
import { mergeStreamText } from "./streaming.js";

export async function runProviderTurnWithFailover(params: {
  sessionId: string;
  primaryProviderId: string;
  routeId?: string;
  fallbackProviderIds?: string[];
  authStore: AuthStore;
  messages: ChatMessage[];
  inputImages?: ChatInputImage[];
  resolveInputImageRef?: (ref: ChatImageRef) => ChatInputImage | null;
  onEvent: StreamEventHandler;
  signal?: AbortSignal;
  profiles: Map<string, ProviderProfile>;
  adapters: Map<string, ProviderAdapter>;
  failover: ProviderFailoverState;
}): Promise<{ providerId: string; assistantBuffer: string }> {
  const candidates = params.failover.resolveCandidates(params.primaryProviderId, params.fallbackProviderIds);
  let lastError: unknown = null;
  let attempt = 0;

  for (const providerId of candidates) {
    attempt += 1;
    const profile = params.profiles.get(providerId);
    if (!profile) {
      continue;
    }
    const adapter = params.adapters.get(profile.adapterId);
    if (!adapter) {
      continue;
    }

    let assistantBuffer = "";
    const onEvent: StreamEventHandler = (event) => {
      if (event.type === "response.delta" && typeof event.payload.text === "string") {
        assistantBuffer = mergeStreamText(assistantBuffer, event.payload.text);
      }
      params.onEvent(event);
    };

    try {
      await adapter.runTurn({
        sessionId: params.sessionId,
        providerId: profile.id,
        profile,
        messages: params.messages,
        inputImages: params.inputImages,
        resolveInputImageRef: params.resolveInputImageRef,
        resolveBearerToken: (authProfileId) =>
          resolveProviderBearerToken({
            authStore: params.authStore,
            profile,
            authProfileId
          }),
        emit: onEvent,
        signal: params.signal
      });
      return {
        providerId: profile.id,
        assistantBuffer
      };
    } catch (error) {
      lastError = error;
      const failureClass = classifyProviderFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      params.failover.recordProviderFailure({
        providerId: profile.id,
        failureClass,
        message
      });

      params.onEvent({
        type: "provider.error",
        sessionId: params.sessionId,
        providerId: profile.id,
        timestamp: nowIso(),
        payload: {
          error: `Provider ${profile.id} failed (${failureClass}): ${message}`,
          metadata: {
            attempt,
            failureClass,
            failoverEnabled: params.failover.isEnabled(),
            ...(params.routeId ? { routeId: params.routeId } : {}),
            cooldownSeconds: params.failover.remainingCooldownSeconds(profile.id)
          }
        }
      });

      if (!params.failover.isEnabled() || failureClass === "fatal_request") {
        throw error;
      }

      if (attempt < candidates.length && params.failover.getRetryDelayMs() > 0) {
        const delayMs = Math.floor(
          params.failover.getRetryDelayMs() *
            Math.pow(params.failover.getBackoffMultiplier(), Math.max(0, attempt - 1))
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`No provider available for session ${params.sessionId}`);
}
