import { renderTelegramFinalMessage } from "../telegram-renderer.js";
import { TELEGRAM_MAX_MESSAGE_CHARS, type TelegramMessagePayload } from "./types.js";

export function splitTelegramText(input: string): string[] {
  const text = input.trim();
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += TELEGRAM_MAX_MESSAGE_CHARS) {
    chunks.push(text.slice(offset, offset + TELEGRAM_MAX_MESSAGE_CHARS));
  }
  return chunks;
}

export function buildFinalTelegramPayloads(rawAssistantText: string): TelegramMessagePayload[] {
  const renderedChunks = renderTelegramFinalMessage(rawAssistantText, {
    maxHtmlChars: TELEGRAM_MAX_MESSAGE_CHARS
  });
  if (renderedChunks.length === 0) {
    return [];
  }

  return renderedChunks.map((chunk) => {
    if (chunk.parseMode === "HTML") {
      return {
        text: chunk.text,
        parseMode: "HTML"
      };
    }
    return { text: chunk.text };
  });
}

export function mergeStreamText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
    if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}
