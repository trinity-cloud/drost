import { describe, expect, it } from "vitest";
import { applySessionHistoryBudget } from "../sessions.js";

describe("sessions history budget", () => {
  it("keeps lead system messages when trimming by maxMessages", () => {
    const result = applySessionHistoryBudget({
      sessionId: "s-1",
      history: [
        { role: "system", content: "policy", createdAt: "2026-02-26T00:00:00.000Z" },
        { role: "user", content: "u1", createdAt: "2026-02-26T00:00:01.000Z" },
        { role: "assistant", content: "a1", createdAt: "2026-02-26T00:00:02.000Z" },
        { role: "user", content: "u2", createdAt: "2026-02-26T00:00:03.000Z" },
        { role: "assistant", content: "a2", createdAt: "2026-02-26T00:00:04.000Z" }
      ],
      policy: {
        enabled: true,
        maxMessages: 3,
        preserveSystemMessages: true
      }
    });

    expect(result.trimmed).toBe(true);
    expect(result.history.map((message) => `${message.role}:${message.content}`)).toEqual([
      "system:policy",
      "user:u2",
      "assistant:a2"
    ]);
  });

  it("trims by maxChars while preserving system messages", () => {
    const result = applySessionHistoryBudget({
      history: [
        { role: "system", content: "system", createdAt: "2026-02-26T00:00:00.000Z" },
        { role: "user", content: "12345", createdAt: "2026-02-26T00:00:01.000Z" },
        { role: "assistant", content: "67890", createdAt: "2026-02-26T00:00:02.000Z" }
      ],
      policy: {
        enabled: true,
        maxChars: 11,
        preserveSystemMessages: true
      }
    });

    expect(result.trimmed).toBe(true);
    expect(result.history.map((message) => `${message.role}:${message.content}`)).toEqual([
      "system:system",
      "assistant:67890"
    ]);
  });

  it("uses summarize hook before applying caps", () => {
    let summarizeCalled = false;
    const result = applySessionHistoryBudget({
      sessionId: "s-2",
      history: [
        { role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" },
        { role: "assistant", content: "world", createdAt: "2026-02-26T00:00:01.000Z" }
      ],
      policy: {
        enabled: true,
        maxMessages: 2,
        summarize: ({ sessionId, history }) => {
          summarizeCalled = true;
          expect(sessionId).toBe("s-2");
          expect(history).toHaveLength(2);
          return [
            { role: "system", content: "summary", createdAt: "2026-02-26T00:00:02.000Z" },
            { role: "assistant", content: "next", createdAt: "2026-02-26T00:00:03.000Z" },
            { role: "assistant", content: "tail", createdAt: "2026-02-26T00:00:04.000Z" }
          ];
        }
      }
    });

    expect(summarizeCalled).toBe(true);
    expect(result.history.map((message) => message.content)).toEqual(["summary", "tail"]);
  });
});
