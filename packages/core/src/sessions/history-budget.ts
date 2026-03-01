import type { ChatMessage } from "../types.js";
import { isChatRole } from "./utils.js";
import type { SessionHistoryBudgetPolicy, SessionHistoryBudgetResult } from "./types.js";

function totalCharacterCount(history: ChatMessage[]): number {
  let total = 0;
  for (const message of history) {
    total += message.content.length;
  }
  return total;
}

function trimToMaxMessages(history: ChatMessage[], maxMessages: number, preserveSystemMessages: boolean): ChatMessage[] {
  if (history.length <= maxMessages) {
    return history;
  }

  if (!preserveSystemMessages || maxMessages <= 0) {
    return history.slice(-Math.max(0, maxMessages));
  }

  let leadSystemCount = 0;
  while (leadSystemCount < history.length && history[leadSystemCount]?.role === "system") {
    leadSystemCount += 1;
  }

  const fixedSystem = history.slice(0, Math.min(leadSystemCount, maxMessages));
  const tailSlots = Math.max(0, maxMessages - fixedSystem.length);
  const tailSource = history.slice(leadSystemCount);
  const tail = tailSource.slice(-tailSlots);
  return [...fixedSystem, ...tail];
}

function trimToMaxChars(history: ChatMessage[], maxChars: number, preserveSystemMessages: boolean): SessionHistoryBudgetResult {
  if (maxChars <= 0) {
    const droppedCharacters = totalCharacterCount(history);
    return {
      history: [],
      trimmed: history.length > 0,
      droppedMessages: history.length,
      droppedCharacters
    };
  }

  const kept = [...history];
  let droppedMessages = 0;
  let droppedCharacters = 0;
  while (totalCharacterCount(kept) > maxChars && kept.length > 0) {
    let dropIndex = 0;
    if (preserveSystemMessages) {
      const firstNonSystem = kept.findIndex((message) => message.role !== "system");
      if (firstNonSystem >= 0) {
        dropIndex = firstNonSystem;
      }
    }
    const [removed] = kept.splice(dropIndex, 1);
    if (removed) {
      droppedMessages += 1;
      droppedCharacters += removed.content.length;
    }
  }

  return {
    history: kept,
    trimmed: droppedMessages > 0,
    droppedMessages,
    droppedCharacters
  };
}

export function applySessionHistoryBudget(params: {
  sessionId?: string;
  history: ChatMessage[];
  policy?: SessionHistoryBudgetPolicy;
}): SessionHistoryBudgetResult {
  const policy = params.policy;
  if (!policy || policy.enabled === false) {
    return {
      history: [...params.history],
      trimmed: false,
      droppedMessages: 0,
      droppedCharacters: 0
    };
  }

  let working = [...params.history];
  if (typeof policy.summarize === "function") {
    try {
      const summarized = policy.summarize({
        sessionId: params.sessionId,
        history: [...working]
      });
      if (Array.isArray(summarized)) {
        working = summarized.filter((message): message is ChatMessage => {
          return (
            message &&
            typeof message === "object" &&
            isChatRole(message.role) &&
            typeof message.content === "string" &&
            typeof message.createdAt === "string"
          );
        });
      }
    } catch {
      // summarize hook is best effort
    }
  }

  const preserveSystemMessages = policy.preserveSystemMessages ?? true;
  let droppedMessages = 0;
  let droppedCharacters = 0;
  if (typeof policy.maxMessages === "number" && Number.isFinite(policy.maxMessages) && policy.maxMessages >= 0) {
    const before = working;
    working = trimToMaxMessages(working, Math.floor(policy.maxMessages), preserveSystemMessages);
    droppedMessages += Math.max(0, before.length - working.length);
    droppedCharacters += Math.max(0, totalCharacterCount(before) - totalCharacterCount(working));
  }

  if (typeof policy.maxChars === "number" && Number.isFinite(policy.maxChars) && policy.maxChars >= 0) {
    const charTrim = trimToMaxChars(working, Math.floor(policy.maxChars), preserveSystemMessages);
    working = charTrim.history;
    droppedMessages += charTrim.droppedMessages;
    droppedCharacters += charTrim.droppedCharacters;
  }

  return {
    history: working,
    trimmed: droppedMessages > 0 || droppedCharacters > 0,
    droppedMessages,
    droppedCharacters
  };
}
