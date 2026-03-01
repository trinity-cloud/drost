import { renderTelegramStreamingPreview } from "../telegram-renderer.js";
import { buildFinalTelegramPayloads, mergeStreamText, splitTelegramText } from "./render-utils.js";
import { toText, type TelegramStreamingRuntime } from "./types.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function startTypingSignal(runtime: TelegramStreamingRuntime): { stop: () => void } {
  let stopped = false;
  const sendOnce = (): void => {
    if (stopped) {
      return;
    }
    void runtime.sendChatAction(runtime.chatId, "typing").catch((error) => {
      runtime.reportError(error);
    });
  };

  sendOnce();
  const timer = setInterval(() => {
    sendOnce();
  }, runtime.typingIntervalMs);

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function handleTurnResponseStreaming(runtime: TelegramStreamingRuntime): Promise<void> {
  const typing = startTypingSignal(runtime);
  let streamedText = "";
  let streamedPreviewText = "";
  let leadMessageId: number | null = null;
  let leadText = "";
  let streamTicker: NodeJS.Timeout | null = null;
  let flushInProgress = false;
  let pendingFlush: Promise<void> | null = null;

  const flushLead = async (force = false, previewFirst = false): Promise<void> => {
    if (flushInProgress) {
      return;
    }
    const chunks = splitTelegramText(streamedPreviewText);
    let nextLead = chunks[0] ?? "";
    if (!nextLead) {
      return;
    }
    if (leadMessageId === null && previewFirst && nextLead.length > runtime.streamPreviewChars) {
      nextLead = nextLead.slice(0, runtime.streamPreviewChars);
    }
    if (!force && nextLead === leadText) {
      return;
    }

    flushInProgress = true;
    try {
      if (leadMessageId === null) {
        leadMessageId = await runtime.sendMessage(runtime.chatId, nextLead);
      } else {
        try {
          await runtime.editMessage(runtime.chatId, leadMessageId, nextLead);
        } catch (error) {
          if (!runtime.isNotModifiedError(error)) {
            throw error;
          }
        }
      }
      leadText = nextLead;
    } finally {
      flushInProgress = false;
    }
  };

  const animateLeadTo = async (targetText: string): Promise<void> => {
    if (!targetText || leadText === targetText) {
      return;
    }

    if (leadMessageId === null) {
      const seed = targetText.slice(0, Math.min(runtime.streamPreviewChars, targetText.length));
      leadMessageId = await runtime.sendMessage(runtime.chatId, seed);
      leadText = seed;
    } else if (leadText.length === 0) {
      const seed = targetText.slice(0, Math.min(runtime.streamPreviewChars, targetText.length));
      await runtime.editMessage(runtime.chatId, leadMessageId, seed);
      leadText = seed;
    }

    if (leadText === targetText || !leadMessageId) {
      return;
    }

    const remaining = targetText.length - leadText.length;
    const adaptiveStep = Math.max(runtime.syntheticStreamStepChars, Math.ceil(remaining / 18));
    let cursor = leadText.length;
    while (cursor < targetText.length) {
      cursor = Math.min(targetText.length, cursor + adaptiveStep);
      const next = targetText.slice(0, cursor);
      try {
        await runtime.editMessage(runtime.chatId, leadMessageId, next);
        leadText = next;
      } catch (error) {
        if (!runtime.isNotModifiedError(error)) {
          throw error;
        }
      }
      if (cursor < targetText.length) {
        await sleep(runtime.syntheticStreamIntervalMs);
      }
    }
  };

  const ensureStreamTicker = (): void => {
    if (streamTicker) {
      return;
    }
    streamTicker = setInterval(() => {
      void flushLead().catch((error) => runtime.reportError(error));
    }, runtime.streamFlushIntervalMs);
  };

  try {
    const result = await runtime.context.runTurn({
      ...runtime.request,
      onEvent: (event) => {
        runtime.request.onEvent?.(event);
        if (event.type !== "response.delta") {
          return;
        }
        const delta = toText(event.payload.text);
        if (!delta) {
          return;
        }
        const nextStreamedText = mergeStreamText(streamedText, delta);
        if (nextStreamedText === streamedText) {
          return;
        }
        streamedText = nextStreamedText;
        const nextPreviewText = renderTelegramStreamingPreview(streamedText);
        if (nextPreviewText === streamedPreviewText) {
          return;
        }
        streamedPreviewText = nextPreviewText;
        if (leadMessageId === null && !pendingFlush) {
          pendingFlush = flushLead(false, true).catch((error) => runtime.reportError(error));
        }
        ensureStreamTicker();
      }
    });

    if (streamTicker) {
      clearInterval(streamTicker);
      streamTicker = null;
    }
    if (pendingFlush) {
      await pendingFlush;
      pendingFlush = null;
    }
    await flushLead(true);

    const streamedFinalText = renderTelegramStreamingPreview(streamedText);
    const fallbackFinalText = renderTelegramStreamingPreview(result.response);
    const finalRawText = streamedFinalText.trim().length > 0 ? streamedText : result.response;
    const finalPayloads = buildFinalTelegramPayloads(
      finalRawText.trim().length > 0 ? finalRawText : `${streamedFinalText || fallbackFinalText}`
    );
    if (finalPayloads.length === 0) {
      return;
    }

    const firstPayload = finalPayloads[0]!;
    const shouldAnimate =
      firstPayload.parseMode === undefined &&
      firstPayload.text.length > runtime.streamPreviewChars &&
      (leadText.length === 0 || leadText.length < firstPayload.text.length);

    if (shouldAnimate) {
      await animateLeadTo(firstPayload.text);
    } else if (leadMessageId === null) {
      leadMessageId = await runtime.sendMessage(runtime.chatId, firstPayload.text, firstPayload.parseMode);
      leadText = firstPayload.text;
    } else if (firstPayload.text !== leadText || firstPayload.parseMode === "HTML") {
      try {
        await runtime.editMessage(runtime.chatId, leadMessageId, firstPayload.text, firstPayload.parseMode);
      } catch (error) {
        if (!runtime.isNotModifiedError(error)) {
          throw error;
        }
      }
      leadText = firstPayload.text;
    }

    for (let index = 1; index < finalPayloads.length; index += 1) {
      const payload = finalPayloads[index];
      if (!payload || !payload.text) {
        continue;
      }
      await runtime.sendMessage(runtime.chatId, payload.text, payload.parseMode);
    }
  } finally {
    if (streamTicker) {
      clearInterval(streamTicker);
    }
    typing.stop();
  }
}
