import { describe, expect, it } from "vitest";
import type { NormalizedStreamEvent } from "@drost/core";
import {
  applyStreamEventToConversation,
  createTuiConversationBuffers,
  hydrateSessionHistory,
  pushUserMessage
} from "../tui-state.js";

function streamEvent(overrides: Partial<NormalizedStreamEvent>): NormalizedStreamEvent {
  return {
    type: "response.delta",
    sessionId: "local",
    providerId: "openai-codex",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {},
    ...overrides
  };
}

describe("tui conversation buffers", () => {
  it("keeps user prompt and coalesces assistant streaming text into one message", () => {
    const buffers = createTuiConversationBuffers();

    pushUserMessage(buffers, {
      sessionId: "local",
      providerId: "openai-codex",
      text: "Hey there"
    });

    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "response.delta",
        payload: {
          text: "Hello"
        }
      })
    );
    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "response.delta",
        payload: {
          text: " world"
        }
      })
    );

    expect(buffers.transcript).toHaveLength(2);
    expect(buffers.transcript[0]?.role).toBe("user");
    expect(buffers.transcript[0]?.text).toBe("Hey there");
    expect(buffers.transcript[1]?.role).toBe("assistant");
    expect(buffers.transcript[1]?.text).toBe("Hello world");
    expect(buffers.transcript[1]?.streaming).toBe(true);

    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "response.completed"
      })
    );

    expect(buffers.transcript[1]?.streaming).toBe(false);
    expect(buffers.activeAssistantBySession.size).toBe(0);
  });

  it("attaches usage to the active assistant message and appends provider errors", () => {
    const buffers = createTuiConversationBuffers();

    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "response.delta",
        payload: {
          text: "partial answer"
        }
      })
    );

    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "usage.updated",
        payload: {
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            totalTokens: 46
          }
        }
      })
    );

    expect(buffers.transcript[0]?.usage).toBe("in=12 out=34 total=46");

    applyStreamEventToConversation(
      buffers,
      streamEvent({
        type: "provider.error",
        payload: {
          error: "boom"
        }
      })
    );

    expect(buffers.transcript).toHaveLength(2);
    expect(buffers.transcript[0]?.streaming).toBe(false);
    expect(buffers.transcript[1]?.role).toBe("error");
    expect(buffers.transcript[1]?.text).toBe("boom");
    expect(buffers.activeAssistantBySession.size).toBe(0);
  });

  it("hydrates transcript from persisted session history", () => {
    const buffers = createTuiConversationBuffers();

    hydrateSessionHistory(buffers, {
      sessionId: "local",
      providerId: "openai-codex",
      history: [
        {
          role: "user",
          content: "hello from disk",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        {
          role: "assistant",
          content: "hi from disk",
          createdAt: "2026-01-01T00:00:01.000Z"
        }
      ]
    });

    expect(buffers.transcript).toHaveLength(2);
    expect(buffers.transcript[0]?.role).toBe("user");
    expect(buffers.transcript[0]?.text).toBe("hello from disk");
    expect(buffers.transcript[1]?.role).toBe("assistant");
    expect(buffers.transcript[1]?.text).toBe("hi from disk");
    expect(buffers.transcript[1]?.streaming).toBe(false);
  });
});
