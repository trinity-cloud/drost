import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelAdapter, ChannelAdapterContext, GatewayConfig } from "../index.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-channels-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake-provider-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    let lastUser = "";
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const message = request.messages[index];
      if (message?.role === "user") {
        lastUser = message.content;
        break;
      }
    }
    const text = `echo:${lastUser}`;
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: { text }
    });
  }
}

class FakeChannelAdapter implements ChannelAdapter {
  readonly id = "fake-channel";
  connected = false;
  disconnected = false;
  context: ChannelAdapterContext | null = null;

  connect(context: ChannelAdapterContext): void {
    this.connected = true;
    this.context = context;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function makeConfig(workspaceDir: string, channels: ChannelAdapter[] = []): GatewayConfig {
  return {
    workspaceDir,
    channels,
    providers: {
      defaultSessionProvider: "provider-a",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "provider-a",
          adapterId: "fake-provider-adapter",
          kind: "openai-compatible",
          baseUrl: "https://example.com",
          model: "demo",
          authProfileId: "auth:a"
        }
      ],
      adapters: [new FakeProviderAdapter()]
    }
  };
}

describe("gateway channels", () => {
  it("connects configured channel adapters and routes channel turns into sessions", async () => {
    const workspaceDir = makeTempDir();
    const channel = new FakeChannelAdapter();
    const gateway = createGateway(makeConfig(workspaceDir, [channel]));

    await gateway.start();
    try {
      expect(channel.connected).toBe(true);
      expect(gateway.listChannelAdapterIds()).toEqual(["fake-channel"]);

      if (!channel.context) {
        throw new Error("Channel context was not assigned");
      }

      const turnResult = await channel.context.runTurn({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        input: "hello from telegram",
        title: "Telegram Chat"
      });

      expect(turnResult.sessionId).toBe("session:telegram:wk-1:chat-1");
      expect(turnResult.providerId).toBe("provider-a");
      expect(turnResult.response).toContain("echo:hello from telegram");

      const exported = gateway.exportSession(turnResult.sessionId);
      expect(exported?.metadata.origin?.channel).toBe("telegram");
      expect(exported?.metadata.origin?.workspaceId).toBe("wk-1");
      expect(exported?.metadata.origin?.chatId).toBe("chat-1");
    } finally {
      await gateway.stop();
    }

    expect(channel.disconnected).toBe(true);
  });

  it("provides dispatchCommand on channel context and handles /status", async () => {
    const workspaceDir = makeTempDir();
    const channel = new FakeChannelAdapter();
    const gateway = createGateway(makeConfig(workspaceDir, [channel]));

    await gateway.start();
    try {
      expect(channel.context).not.toBeNull();
      expect(typeof channel.context?.dispatchCommand).toBe("function");

      const result = await channel.context!.dispatchCommand!({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        input: "/status"
      });

      expect(result.handled).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("Gateway: running");
    } finally {
      await gateway.stop();
    }
  });

  it("queues continuity exactly once when channel /new is dispatched", async () => {
    const workspaceDir = makeTempDir();
    const channel = new FakeChannelAdapter();
    const gateway = createGateway({
      ...makeConfig(workspaceDir, [channel]),
      sessionStore: {
        enabled: true,
        continuity: {
          enabled: true,
          autoOnNew: true,
          maxParallelJobs: 1
        }
      }
    });

    await gateway.start();
    try {
      expect(channel.context).not.toBeNull();
      const result = await channel.context!.dispatchCommand!({
        identity: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-1"
        },
        input: "/new"
      });

      expect(result.handled).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.action).toBe("new_session");
      expect(typeof result.sessionId).toBe("string");

      const jobs = gateway.listContinuityJobs(20) as Array<{
        fromSessionId?: string;
        toSessionId?: string;
      }>;
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.fromSessionId).toBe("session:telegram:wk-1:chat-1");
      expect(jobs[0]?.toSessionId).toBe(result.sessionId);
    } finally {
      await gateway.stop();
    }
  });

  it("supports dynamic channel registration and duplicate guardrails", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway(makeConfig(workspaceDir));
    const channel = new FakeChannelAdapter();

    gateway.registerChannelAdapter(channel);
    expect(() => gateway.registerChannelAdapter(channel)).toThrow("already registered");
    expect(gateway.listChannelAdapterIds()).toEqual(["fake-channel"]);
    expect(gateway.unregisterChannelAdapter("fake-channel")).toBe(true);
    expect(gateway.unregisterChannelAdapter("fake-channel")).toBe(false);
  });
});
