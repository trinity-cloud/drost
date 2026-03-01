import type { SessionMetadata } from "../../sessions.js";
import type { ChatImageRef, ChatMessage } from "../../types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createSessionMetadata(seed?: Partial<SessionMetadata>): SessionMetadata {
  const now = nowIso();
  const metadata: SessionMetadata = {
    createdAt: seed?.createdAt ?? now,
    lastActivityAt: seed?.lastActivityAt ?? seed?.createdAt ?? now,
    title: seed?.title,
    origin: seed?.origin
  };
  if (typeof seed?.providerRouteId === "string" && seed.providerRouteId.trim().length > 0) {
    metadata.providerRouteId = seed.providerRouteId.trim();
  }
  if (
    seed?.skillInjectionMode === "off" ||
    seed?.skillInjectionMode === "all" ||
    seed?.skillInjectionMode === "relevant"
  ) {
    metadata.skillInjectionMode = seed.skillInjectionMode;
  }
  return metadata;
}

export function createUserMessage(content: string, imageRefs?: ChatImageRef[]): ChatMessage {
  return {
    role: "user",
    content,
    createdAt: nowIso(),
    imageRefs: Array.isArray(imageRefs) && imageRefs.length > 0 ? imageRefs : undefined
  };
}

export function createAssistantMessage(content: string): ChatMessage {
  return {
    role: "assistant",
    content,
    createdAt: nowIso()
  };
}

export function createToolMessage(content: string): ChatMessage {
  return {
    role: "tool",
    content,
    createdAt: nowIso()
  };
}
