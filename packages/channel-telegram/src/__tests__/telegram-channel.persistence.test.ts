import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramChannelAdapter } from "../telegram-channel.js";
import type { ChannelTurnRequest, ChannelTurnResult } from "@drost/core";

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

describe("telegram channel adapter persistence", () => {
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
    const fetchImpl: typeof fetch = async (input) => {
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
      runTurn: async (request: ChannelTurnRequest): Promise<ChannelTurnResult> => {
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
      runTurn: async (request: ChannelTurnRequest): Promise<ChannelTurnResult> => {
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
      runTurn: async (): Promise<ChannelTurnResult> => {
        turnCount += 1;
        return {
          sessionId: "session:telegram:global:9001",
          providerId: "provider-a",
          response: "ok"
        };
      }
    });
    second.connect({
      runTurn: async (): Promise<ChannelTurnResult> => {
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
