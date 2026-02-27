import { describe, expect, it } from "vitest";
import { buildChannelSessionId, createChannelSessionOrigin } from "../session-mapping.js";

describe("sessions channel mapping", () => {
  it("builds deterministic channel-scoped session ids", () => {
    const identity = {
      channel: "Telegram",
      workspaceId: "My Workspace",
      userId: "User_123"
    };

    const first = buildChannelSessionId(identity);
    const second = buildChannelSessionId(identity);
    expect(first).toBe(second);
    expect(first).toBe("session:telegram:my-workspace:user_123");
  });

  it("hashes ids when raw identity exceeds max length", () => {
    const hashed = buildChannelSessionId(
      {
        channel: "telegram",
        workspaceId: "workspace",
        threadId: "thread-" + "x".repeat(200)
      },
      {
        maxLength: 60
      }
    );

    expect(hashed).toMatch(/^session:telegram:[a-f0-9]{20}$/);
  });

  it("preserves source identity in origin payload", () => {
    const origin = createChannelSessionOrigin({
      channel: "slack",
      workspaceId: "wk-1",
      accountId: "acc-1",
      chatId: "chat-1",
      userId: "user-1",
      threadId: "thread-1"
    });
    expect(origin).toEqual({
      channel: "slack",
      workspaceId: "wk-1",
      accountId: "acc-1",
      chatId: "chat-1",
      userId: "user-1",
      threadId: "thread-1"
    });
  });
});
