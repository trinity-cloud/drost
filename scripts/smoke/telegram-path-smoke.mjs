import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../../packages/core/dist/index.js";
import { TelegramChannelAdapter } from "../../packages/channel-telegram/dist/index.js";

class EchoAdapter {
  constructor() {
    this.id = "telegram-smoke-echo-adapter";
  }

  async probe(profile) {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request) {
    const input =
      request.messages
        .filter((entry) => entry.role === "user")
        .at(-1)?.content ?? "";
    const text = `echo:${input}`;
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[telegram-smoke] ${message}`);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`[telegram-smoke] timeout waiting for ${label}`);
}

async function run() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-telegram-smoke-"));
  const sentMessages = [];
  const chatId = 515;
  const oldSessionId = `session:telegram:global:${chatId}`;
  const updateBatches = [
    [
      {
        update_id: 1,
        message: {
          message_id: 1001,
          text: "/new",
          chat: { id: chatId },
          from: { id: 99 }
        }
      }
    ],
    [
      {
        update_id: 2,
        message: {
          message_id: 1002,
          text: "message-new",
          chat: { id: chatId },
          from: { id: 99 }
        }
      }
    ],
    [
      {
        update_id: 3,
        message: {
          message_id: 1003,
          text: `/session ${oldSessionId}`,
          chat: { id: chatId },
          from: { id: 99 }
        }
      }
    ],
    [
      {
        update_id: 4,
        message: {
          message_id: 1004,
          text: "message-old",
          chat: { id: chatId },
          from: { id: 99 }
        }
      }
    ],
    [
      {
        update_id: 5,
        message: {
          message_id: 1005,
          text: "/sessions",
          chat: { id: chatId },
          from: { id: 99 }
        }
      }
    ],
    []
  ];

  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/getUpdates")) {
      const next = updateBatches.shift() ?? [];
      return new Response(JSON.stringify({ ok: true, result: next }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/sendChatAction")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/sendMessage")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      sentMessages.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length + 2000 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/setMyCommands") || url.includes("/deleteMyCommands")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const telegram = new TelegramChannelAdapter({
    token: "telegram-smoke-token",
    pollIntervalMs: 20,
    persistState: false,
    fetchImpl
  });

  const gateway = createGateway({
    workspaceDir,
    channels: [telegram],
    orchestration: {
      enabled: true,
      defaultMode: "queue",
      persistState: true
    },
    providers: {
      defaultSessionProvider: "echo",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "echo",
          adapterId: "telegram-smoke-echo-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:echo"
        }
      ],
      adapters: [new EchoAdapter()]
    }
  });

  await gateway.start();
  try {
    const createdText = await waitFor(
      () => sentMessages.map((entry) => String(entry?.text ?? "")).find((text) => text.includes("Started new session:")),
      15_000,
      "new session command response"
    );
    const createdMatch = createdText.match(/Started new session:\s+([^\s]+)/);
    assert(createdMatch?.[1], `unable to parse new session id from: ${createdText}`);
    const newSessionId = createdMatch[1];

    await waitFor(
      () => gateway.getSessionHistory(newSessionId).some((entry) => entry.content.includes("message-new")),
      15_000,
      "new session message persistence"
    );
    await waitFor(
      () => gateway.getSessionHistory(oldSessionId).some((entry) => entry.content.includes("message-old")),
      15_000,
      "old session message after /session switch"
    );

    await waitFor(
      () =>
        sentMessages
          .map((entry) => String(entry?.text ?? ""))
          .some((text) => text.includes(oldSessionId) && text.includes(newSessionId)),
      15_000,
      "/sessions command output"
    );

    const lanes = gateway.listOrchestrationLaneStatuses();
    assert(lanes.some((lane) => lane.sessionId === oldSessionId || lane.sessionId === newSessionId), "missing orchestration lane state for telegram sessions");
  } finally {
    await gateway.stop();
  }

  process.stdout.write(`[telegram-smoke] ok workspace=${workspaceDir}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
