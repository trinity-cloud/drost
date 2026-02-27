import { afterEach, describe, expect, it } from "vitest";
import { TelegramChannelAdapter } from "../telegram-channel.js";
import type { ChannelTurnRequest, ChannelTurnResult } from "@drost/core";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

const activeAdapters: TelegramChannelAdapter[] = [];

afterEach(async () => {
  while (activeAdapters.length > 0) {
    const next = activeAdapters.pop();
    if (!next) {
      continue;
    }
    await next.disconnect();
  }
});

describe("telegram channel adapter", () => {
  it("polls telegram updates, runs channel turns, and sends responses", async () => {
    const calls: FetchCall[] = [];
    const turnRequests: ChannelTurnRequest[] = [];
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 1,
          message: {
            message_id: 10,
            text: "ping",
            chat: {
              id: 42,
              title: "Core Chat"
            },
            from: {
              id: 7
            }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({
          ok: true,
          result: next
        });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({
          ok: true,
          result: {
            message_id: 11
          }
        });
      }
      return jsonResponse({
        ok: false,
        description: "unknown method",
        result: []
      });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      workspaceId: "wk-1",
      pollIntervalMs: 20,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    const runTurn = async (request: ChannelTurnRequest): Promise<ChannelTurnResult> => {
      turnRequests.push(request);
      return {
        sessionId: "session:telegram:wk-1:42",
        providerId: "provider-a",
        response: `echo:${request.input}`
      };
    };

    adapter.connect({
      runTurn
    });

    await waitFor(() => turnRequests.length === 1 && sentMessages.length === 1);

    expect(turnRequests[0]?.identity.channel).toBe("telegram");
    expect(turnRequests[0]?.identity.workspaceId).toBe("wk-1");
    expect(turnRequests[0]?.identity.chatId).toBe("42");
    expect(turnRequests[0]?.identity.userId).toBe("7");
    expect(turnRequests[0]?.title).toBe("Core Chat");
    expect(turnRequests[0]?.input).toBe("ping");

    expect(sentMessages[0]?.chat_id).toBe(42);
    expect(sentMessages[0]?.text).toBe("echo:ping");
    expect(calls.some((call) => call.url.includes("/getUpdates"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/sendMessage"))).toBe(true);
  });

  it("handles empty and non-text updates without sending replies", async () => {
    const sentMessages: unknown[] = [];
    let getUpdatesCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        getUpdatesCount += 1;
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 10
            },
            {
              update_id: 11,
              message: {
                message_id: 90,
                chat: {
                  id: 123
                }
              }
            }
          ]
        });
      }
      if (url.includes("/sendMessage")) {
        sentMessages.push(init?.body ?? null);
        return jsonResponse({
          ok: true,
          result: {}
        });
      }
      return jsonResponse({
        ok: true,
        result: []
      });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      fetchImpl
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async () => ({
        sessionId: "session:telegram:global:123",
        response: "unused"
      })
    });

    await waitFor(() => getUpdatesCount >= 1);
    expect(sentMessages.length).toBe(0);
  });
});
