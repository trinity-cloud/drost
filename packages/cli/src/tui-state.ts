import type { ChatMessage, NormalizedStreamEvent } from "@drost/core";
import type { TuiTranscriptEntry } from "@drost/tui";

const DEFAULT_MAX_TRANSCRIPT = 300;
const DEFAULT_MAX_EVENTS = 300;

export interface TuiConversationBuffers {
  transcript: TuiTranscriptEntry[];
  events: string[];
  activeAssistantBySession: Map<string, string>;
  nextMessageId: number;
}

export function createTuiConversationBuffers(): TuiConversationBuffers {
  return {
    transcript: [],
    events: [],
    activeAssistantBySession: new Map<string, string>(),
    nextMessageId: 0
  };
}

function trimEvents(buffers: TuiConversationBuffers, maxEvents: number = DEFAULT_MAX_EVENTS): void {
  if (buffers.events.length <= maxEvents) {
    return;
  }
  buffers.events.splice(0, buffers.events.length - maxEvents);
}

function trimTranscript(
  buffers: TuiConversationBuffers,
  maxTranscript: number = DEFAULT_MAX_TRANSCRIPT
): void {
  if (buffers.transcript.length <= maxTranscript) {
    return;
  }
  const removed = buffers.transcript.splice(0, buffers.transcript.length - maxTranscript);
  if (removed.length === 0) {
    return;
  }
  const removedIds = new Set<string>(removed.map((entry) => entry.id));
  for (const [sessionId, messageId] of buffers.activeAssistantBySession.entries()) {
    if (removedIds.has(messageId)) {
      buffers.activeAssistantBySession.delete(sessionId);
    }
  }
}

function createMessageId(buffers: TuiConversationBuffers): string {
  buffers.nextMessageId += 1;
  return `m-${buffers.nextMessageId}`;
}

function findTranscriptIndex(
  buffers: TuiConversationBuffers,
  messageId: string | undefined
): number {
  if (!messageId) {
    return -1;
  }
  return buffers.transcript.findIndex((entry) => entry.id === messageId);
}

export function pushEventLine(buffers: TuiConversationBuffers, line: string): void {
  const normalized = line.trim();
  if (!normalized) {
    return;
  }
  buffers.events.push(normalized);
  trimEvents(buffers);
}

export function pushEventLines(buffers: TuiConversationBuffers, lines: string[]): void {
  for (const line of lines) {
    pushEventLine(buffers, line);
  }
}

export function pushUserMessage(
  buffers: TuiConversationBuffers,
  params: {
    sessionId: string;
    providerId: string;
    text: string;
  }
): void {
  const message = params.text.trim();
  if (!message) {
    return;
  }
  buffers.transcript.push({
    id: createMessageId(buffers),
    role: "user",
    sessionId: params.sessionId,
    providerId: params.providerId,
    text: message
  });
  trimTranscript(buffers);
}

function mapHistoryRole(role: ChatMessage["role"]): TuiTranscriptEntry["role"] {
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "system";
}

export function hydrateSessionHistory(
  buffers: TuiConversationBuffers,
  params: {
    sessionId: string;
    providerId?: string;
    history: ChatMessage[];
  }
): void {
  if (params.history.length === 0) {
    return;
  }
  for (const message of params.history) {
    const text = message.content.replace(/\r/g, "");
    if (!text.trim()) {
      continue;
    }
    buffers.transcript.push({
      id: createMessageId(buffers),
      role: mapHistoryRole(message.role),
      sessionId: params.sessionId,
      providerId: params.providerId,
      text,
      streaming: false
    });
    trimTranscript(buffers);
  }
  buffers.activeAssistantBySession.delete(params.sessionId);
}

function ensureAssistantMessage(
  buffers: TuiConversationBuffers,
  params: {
    sessionId: string;
    providerId: string;
  }
): TuiTranscriptEntry {
  const activeMessageId = buffers.activeAssistantBySession.get(params.sessionId);
  const existingIndex = findTranscriptIndex(buffers, activeMessageId);
  if (existingIndex >= 0) {
    return buffers.transcript[existingIndex]!;
  }
  const created: TuiTranscriptEntry = {
    id: createMessageId(buffers),
    role: "assistant",
    sessionId: params.sessionId,
    providerId: params.providerId,
    text: "",
    streaming: true
  };
  buffers.transcript.push(created);
  buffers.activeAssistantBySession.set(params.sessionId, created.id);
  trimTranscript(buffers);
  return created;
}

function finalizeAssistantStream(buffers: TuiConversationBuffers, sessionId: string): void {
  const messageId = buffers.activeAssistantBySession.get(sessionId);
  if (!messageId) {
    return;
  }
  const index = findTranscriptIndex(buffers, messageId);
  if (index >= 0) {
    const entry = buffers.transcript[index]!;
    entry.streaming = false;
  }
  buffers.activeAssistantBySession.delete(sessionId);
}

export function applyStreamEventToConversation(
  buffers: TuiConversationBuffers,
  event: NormalizedStreamEvent
): void {
  if (event.type === "response.delta") {
    const message = ensureAssistantMessage(buffers, {
      sessionId: event.sessionId,
      providerId: event.providerId
    });
    message.providerId = event.providerId;
    message.text += event.payload.text ?? "";
    return;
  }

  if (event.type === "usage.updated") {
    const messageId = buffers.activeAssistantBySession.get(event.sessionId);
    const index = findTranscriptIndex(buffers, messageId);
    if (index < 0) {
      return;
    }
    const usage = event.payload.usage;
    buffers.transcript[index]!.usage = `in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} total=${usage?.totalTokens ?? "?"}`;
    return;
  }

  if (event.type === "provider.error") {
    finalizeAssistantStream(buffers, event.sessionId);
    buffers.transcript.push({
      id: createMessageId(buffers),
      role: "error",
      sessionId: event.sessionId,
      providerId: event.providerId,
      text: event.payload.error ?? "unknown provider error"
    });
    trimTranscript(buffers);
    return;
  }

  if (event.type === "response.completed") {
    finalizeAssistantStream(buffers, event.sessionId);
    return;
  }
}
