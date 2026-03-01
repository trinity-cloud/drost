import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const tempStateDirs: string[] = [];

function createStatePaths(): { stateFilePath: string; lockFilePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-telegram-channel-test-"));
  tempStateDirs.push(dir);
  return {
    stateFilePath: path.join(dir, "state.json"),
    lockFilePath: path.join(dir, "poll.lock")
  };
}

afterEach(async () => {
  while (activeAdapters.length > 0) {
    const next = activeAdapters.pop();
    if (!next) {
      continue;
    }
    await next.disconnect();
  }
  while (tempStateDirs.length > 0) {
    const next = tempStateDirs.pop();
    if (!next) {
      continue;
    }
    try {
      fs.rmSync(next, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for test temp dirs.
    }
  }
});

describe("telegram channel adapter", () => {
  it("polls updates, sends typing action, runs channel turns, and sends responses", async () => {
    const calls: FetchCall[] = [];
    const turnRequests: ChannelTurnRequest[] = [];
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const sentActions: Array<{ chat_id?: number; action?: string }> = [];
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
      if (url.includes("/sendChatAction")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentActions.push(body);
        return jsonResponse({
          ok: true,
          result: true
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
      return jsonResponse({ ok: true, result: true });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      workspaceId: "wk-1",
      pollIntervalMs: 20,
      ...createStatePaths(),
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
    expect(sentActions.length).toBeGreaterThan(0);
    expect(sentActions[0]?.chat_id).toBe(42);
    expect(sentActions[0]?.action).toBe("typing");
    expect(calls.some((call) => call.url.includes("/getUpdates"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/sendMessage"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/sendChatAction"))).toBe(true);
  });

  it("streams response deltas by editing the in-flight telegram message", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const editedMessages: Array<{ chat_id?: number; message_id?: number; text?: string }> = [];
    const sentActions: Array<{ chat_id?: number; action?: string }> = [];
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 12,
          message: {
            message_id: 101,
            text: "stream please",
            chat: {
              id: 55
            },
            from: {
              id: 99
            }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({
          ok: true,
          result: next
        });
      }
      if (url.includes("/sendChatAction")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentActions.push(body);
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({
          ok: true,
          result: {
            message_id: 202
          }
        });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        editedMessages.push(body);
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      return jsonResponse({ ok: true, result: true });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      typingIntervalMs: 1000,
      streamFlushIntervalMs: 1,
      ...createStatePaths(),
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:55",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: "hello"
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 6));
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:55",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: " world"
          }
        });
        return {
          sessionId: "session:telegram:global:55",
          providerId: "provider-a",
          response: "hello world"
        };
      }
    });

    await waitFor(() => sentMessages.length >= 1 && editedMessages.length >= 1);

    expect(sentActions.length).toBeGreaterThan(0);
    expect(sentActions[0]?.chat_id).toBe(55);
    expect(sentActions[0]?.action).toBe("typing");

    expect(sentMessages[0]?.chat_id).toBe(55);
    expect(sentMessages[0]?.text).toBe("hello");

    expect(editedMessages[0]?.chat_id).toBe(55);
    expect(editedMessages[0]?.message_id).toBe(202);
    expect(editedMessages[0]?.text).toBe("hello world");
  });

  it("deduplicates snapshot-style deltas so the opening text is not repeated", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const editedMessages: Array<{ chat_id?: number; message_id?: number; text?: string }> = [];
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 13,
          message: {
            message_id: 102,
            text: "snapshot stream",
            chat: {
              id: 56
            },
            from: {
              id: 100
            }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({
          ok: true,
          result: next
        });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({
          ok: true,
          result: {
            message_id: 203
          }
        });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        editedMessages.push(body);
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      return jsonResponse({ ok: true, result: true });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      streamFlushIntervalMs: 1,
      ...createStatePaths(),
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:56",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: "When debugg"
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 6));
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:56",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: "When debugging, I usually do four things."
          }
        });
        return {
          sessionId: "session:telegram:global:56",
          providerId: "provider-a",
          response: "When debugging, I usually do four things."
        };
      }
    });

    await waitFor(
      () =>
        sentMessages.length >= 1 &&
        editedMessages.some(
          (entry) => (entry.text ?? "") === "When debugging, I usually do four things."
        )
    );

    expect(sentMessages[0]?.chat_id).toBe(56);
    expect(sentMessages[0]?.text).toBe("When debugg");
    expect(editedMessages[editedMessages.length - 1]?.text).toBe(
      "When debugging, I usually do four things."
    );
    expect(
      editedMessages.some((entry) =>
        (entry.text ?? "").startsWith("When debuggWhen debugging")
      )
    ).toBe(false);
  });

  it("progressively edits large single-delta responses for providers that burst output", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const editedMessages: Array<{ chat_id?: number; message_id?: number; text?: string }> = [];
    const bigDelta = "x".repeat(600);
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 20,
          message: {
            message_id: 201,
            text: "burst mode",
            chat: {
              id: 77
            }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({
          ok: true,
          result: next
        });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({
          ok: true,
          result: {
            message_id: 303
          }
        });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        editedMessages.push(body);
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      return jsonResponse({ ok: true, result: true });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      streamFlushIntervalMs: 1,
      streamPreviewChars: 80,
      syntheticStreamStepChars: 120,
      syntheticStreamIntervalMs: 1,
      ...createStatePaths(),
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:77",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: bigDelta
          }
        });
        return {
          sessionId: "session:telegram:global:77",
          providerId: "provider-a",
          response: bigDelta
        };
      }
    });

    await waitFor(
      () =>
        sentMessages.length >= 1 &&
        editedMessages.some((entry) => (entry.text ?? "") === bigDelta)
    );

    expect(sentMessages[0]?.chat_id).toBe(77);
    expect((sentMessages[0]?.text ?? "").length).toBeLessThan(600);
    expect(editedMessages.length).toBeGreaterThanOrEqual(1);
    expect(editedMessages[editedMessages.length - 1]?.text).toBe(bigDelta);
  });

  it("does not duplicate the first message when sendMessage is slower than runTurn", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    const editedMessages: Array<{ chat_id?: number; message_id?: number; text?: string }> = [];
    let sendMessageCallCount = 0;
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 30,
          message: {
            message_id: 301,
            text: "race test",
            chat: { id: 88 },
            from: { id: 1 }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({ ok: true, result: next });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (url.includes("/sendMessage")) {
        sendMessageCallCount += 1;
        // Simulate slow network: the first sendMessage takes longer than runTurn.
        await new Promise((resolve) => setTimeout(resolve, 40));
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({ ok: true, result: { message_id: 400 } });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        editedMessages.push(body);
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({ ok: true, result: true });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      streamFlushIntervalMs: 1,
      persistState: false,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        // Emit delta synchronously, then return immediately.
        // The fire-and-forget flushLead sendMessage is still in-flight when runTurn resolves.
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:88",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: { text: "the full response text" }
        });
        return {
          sessionId: "session:telegram:global:88",
          providerId: "provider-a",
          response: "the full response text"
        };
      }
    });

    await waitFor(() => sentMessages.length >= 1, 2000);
    // Give extra time for any erroneous second sendMessage to fire.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The critical assertion: only ONE sendMessage call should have been made.
    expect(sendMessageCallCount).toBe(1);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]?.chat_id).toBe(88);
  });

  it("intercepts slash commands via dispatchCommand and does not call runTurn", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    let runTurnCalled = false;
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 40,
          message: {
            message_id: 401,
            text: "/status",
            chat: { id: 99 },
            from: { id: 5 }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({ ok: true, result: next });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({ ok: true, result: { message_id: 500 } });
      }
      return jsonResponse({ ok: true, result: [] });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      persistState: false,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        runTurnCalled = true;
        return {
          sessionId: "session:telegram:global:99",
          providerId: "provider-a",
          response: "should not reach here"
        };
      },
      dispatchCommand: async (request) => {
        return {
          handled: true,
          text: "Gateway: running\nStarted: 2026-01-01",
          ok: true
        };
      }
    });

    await waitFor(() => sentMessages.length >= 1);

    expect(runTurnCalled).toBe(false);
    expect(sentMessages[0]?.chat_id).toBe(99);
    expect(sentMessages[0]?.text).toContain("Gateway: running");
  });

  it("keeps mapping unchanged after /new so the next turn reuses the same chat mapping key", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    let runTurnMapping: { prefix?: string } | undefined;
    let dispatchCount = 0;
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 50,
          message: {
            message_id: 501,
            text: "/new",
            chat: { id: 77 },
            from: { id: 8 }
          }
        }
      ],
      [
        {
          update_id: 51,
          message: {
            message_id: 502,
            text: "hello",
            chat: { id: 77 },
            from: { id: 8 }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({ ok: true, result: next });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({ ok: true, result: { message_id: 601 } });
      }
      return jsonResponse({ ok: true, result: [] });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      persistState: false,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        runTurnMapping = request.mapping;
        return {
          sessionId: "telegram-20260228-120000-000",
          providerId: "provider-a",
          response: "ok"
        };
      },
      dispatchCommand: async () => {
        dispatchCount += 1;
        return {
          handled: true,
          text: "Started new session: telegram-20260228-120000-000",
          ok: true,
          action: "new_session",
          sessionId: "telegram-20260228-120000-000"
        };
      }
    });

    await waitFor(() => sentMessages.length >= 2);

    expect(dispatchCount).toBe(1);
    expect(runTurnMapping).toBeUndefined();
    expect(sentMessages[0]?.text).toContain("Started new session");
    expect(sentMessages[1]?.text).toBe("ok");
  });

  it("falls through to runTurn when dispatchCommand returns handled=false", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string }> = [];
    let runTurnCalled = false;
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 41,
          message: {
            message_id: 402,
            text: "/unknown",
            chat: { id: 100 },
            from: { id: 6 }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({ ok: true, result: next });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({ ok: true, result: { message_id: 501 } });
      }
      return jsonResponse({ ok: true, result: [] });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      persistState: false,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        runTurnCalled = true;
        return {
          sessionId: "session:telegram:global:100",
          providerId: "provider-a",
          response: "echo:/unknown"
        };
      },
      dispatchCommand: async () => ({
        handled: false,
        text: ""
      })
    });

    await waitFor(() => sentMessages.length >= 1);

    expect(runTurnCalled).toBe(true);
    expect(sentMessages[0]?.text).toBe("echo:/unknown");
  });

  it("renders final markdown via HTML parse mode and suppresses tool protocol text", async () => {
    const sentMessages: Array<{ chat_id?: number; text?: string; parse_mode?: string }> = [];
    const editedMessages: Array<{
      chat_id?: number;
      message_id?: number;
      text?: string;
      parse_mode?: string;
    }> = [];
    const updateBatches: unknown[][] = [
      [
        {
          update_id: 61,
          message: {
            message_id: 610,
            text: "show pretty output",
            chat: { id: 515 },
            from: { id: 2 }
          }
        }
      ],
      []
    ];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        const next = updateBatches.shift() ?? [];
        return jsonResponse({ ok: true, result: next });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        sentMessages.push(body);
        return jsonResponse({
          ok: true,
          result: {
            message_id: 611
          }
        });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        editedMessages.push(body);
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({ ok: true, result: [] });
    };

    const adapter = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      streamFlushIntervalMs: 1,
      persistState: false,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(adapter);

    adapter.connect({
      runTurn: async (request) => {
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:515",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: "TOOL_CALL {\"name\":\"file\",\"input\":{\"action\":\"read\",\"path\":\"README.md\"}}"
          }
        });
        request.onEvent?.({
          type: "response.delta",
          sessionId: "session:telegram:global:515",
          providerId: "provider-a",
          timestamp: new Date().toISOString(),
          payload: {
            text: "\n\n## Final Answer\n\n- **Bold item**\n- [OpenAI](https://openai.com)"
          }
        });
        return {
          sessionId: "session:telegram:global:515",
          providerId: "provider-a",
          response:
            "TOOL_CALL {\"name\":\"file\",\"input\":{\"action\":\"read\",\"path\":\"README.md\"}}\n\n## Final Answer\n\n- **Bold item**\n- [OpenAI](https://openai.com)"
        };
      }
    });

    await waitFor(
      () =>
        sentMessages.length >= 1 &&
        editedMessages.some((entry) => (entry.parse_mode ?? "").toUpperCase() === "HTML")
    );

    expect(sentMessages[0]?.text).not.toContain("TOOL_CALL");
    expect(editedMessages.some((entry) => (entry.text ?? "").includes("TOOL_CALL"))).toBe(false);
    expect(editedMessages.some((entry) => (entry.parse_mode ?? "").toUpperCase() === "HTML")).toBe(true);
    expect(editedMessages.some((entry) => (entry.text ?? "").includes("<b>Final Answer</b>"))).toBe(true);
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
      ...createStatePaths(),
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

  it("persists last processed message ids and skips replayed updates after restart", async () => {
    const statePaths = createStatePaths();
    const turnInputs: string[] = [];
    let sendCount = 0;
    const update = {
      update_id: 77,
      message: {
        message_id: 500,
        text: "dedupe me",
        chat: {
          id: 1001
        },
        from: {
          id: 7
        }
      }
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [update]
        });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      if (url.includes("/sendMessage")) {
        sendCount += 1;
        return jsonResponse({
          ok: true,
          result: {
            message_id: 9100 + sendCount
          }
        });
      }
      if (url.includes("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      return jsonResponse({
        ok: true,
        result: []
      });
    };

    const first = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      ...statePaths,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(first);
    first.connect({
      runTurn: async (request) => {
        turnInputs.push(request.input);
        return {
          sessionId: "session:telegram:global:1001",
          providerId: "provider-a",
          response: "ok"
        };
      }
    });
    await waitFor(() => turnInputs.length === 1);
    await first.disconnect();
    activeAdapters.pop();

    const second = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      ...statePaths,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    activeAdapters.push(second);
    second.connect({
      runTurn: async (request) => {
        turnInputs.push(request.input);
        return {
          sessionId: "session:telegram:global:1001",
          providerId: "provider-a",
          response: "ok"
        };
      }
    });

    await waitFor(() => fs.existsSync(statePaths.stateFilePath));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(turnInputs).toEqual(["dedupe me"]);
  });

  it("acquires a poll lock so a second process does not poll the same chat", async () => {
    const statePaths = createStatePaths();
    let turnCount = 0;
    const errors: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 501,
              message: {
                message_id: 701,
                text: "only once",
                chat: {
                  id: 9001
                }
              }
            }
          ]
        });
      }
      if (url.includes("/sendChatAction")) {
        return jsonResponse({
          ok: true,
          result: true
        });
      }
      if (url.includes("/sendMessage") || url.includes("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 777
          }
        });
      }
      return jsonResponse({
        ok: true,
        result: []
      });
    };

    const first = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      ...statePaths,
      fetchImpl,
      onError: (error) => {
        throw error;
      }
    });
    const second = new TelegramChannelAdapter({
      token: "test-token",
      pollIntervalMs: 20,
      ...statePaths,
      fetchImpl,
      onError: (error) => {
        errors.push(error.message);
      }
    });
    activeAdapters.push(first);
    activeAdapters.push(second);

    first.connect({
      runTurn: async () => {
        turnCount += 1;
        return {
          sessionId: "session:telegram:global:9001",
          providerId: "provider-a",
          response: "ok"
        };
      }
    });
    second.connect({
      runTurn: async () => {
        turnCount += 1;
        return {
          sessionId: "session:telegram:global:9001",
          providerId: "provider-a",
          response: "ok"
        };
      }
    });

    await waitFor(() => turnCount >= 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(turnCount).toBe(1);
    expect(errors.some((message) => message.includes("lock already held"))).toBe(true);
  });
});
