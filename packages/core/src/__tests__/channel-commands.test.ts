import { describe, expect, it, vi } from "vitest";
import {
  isChannelCommand,
  dispatchChannelCommand,
  type ChannelCommandGateway,
  type ChannelCommandSessionContext
} from "../channel-commands.js";

function makeGateway(overrides: Partial<ChannelCommandGateway> = {}): ChannelCommandGateway {
  return {
    getStatus: () => ({
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      degradedReasons: [],
      agent: { loaded: true, name: "test-agent" }
    }),
    listProviderProfiles: () => [
      {
        id: "provider-a",
        adapterId: "openai",
        kind: "openai-compatible",
        model: "gpt-4",
        authProfileId: "auth:a"
      },
      {
        id: "provider-b",
        adapterId: "anthropic",
        kind: "anthropic",
        model: "claude-sonnet",
        authProfileId: "auth:b"
      }
    ],
    listSessionSnapshots: () => [
      {
        sessionId: "session:telegram:wk:chat-1",
        activeProviderId: "provider-a",
        turnInProgress: false,
        historyCount: 5,
        metadata: {
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T01:00:00.000Z"
        }
      }
    ],
    getSessionState: () => ({
      activeProviderId: "provider-a",
      pendingProviderId: undefined
    }),
    queueSessionProviderSwitch: () => undefined,
    listLoadedToolNames: () => ["shell", "file", "web"],
    runTool: async () => ({
      toolName: "shell",
      ok: true,
      output: "hello world"
    }),
    requestRestart: async () => ({
      ok: true,
      code: "allowed" as const,
      message: "Restart allowed",
      intent: "manual" as const,
      dryRun: false
    }),
    ...overrides
  };
}

const session: ChannelCommandSessionContext = {
  sessionId: "session:telegram:wk:chat-1"
};

describe("isChannelCommand", () => {
  it("returns true for valid slash commands", () => {
    expect(isChannelCommand("/help")).toBe(true);
    expect(isChannelCommand("/status")).toBe(true);
    expect(isChannelCommand("/provider foo")).toBe(true);
    expect(isChannelCommand("/tool shell {\"command\":\"ls\"}")).toBe(true);
    expect(isChannelCommand("  /help  ")).toBe(true);
  });

  it("returns false for non-commands", () => {
    expect(isChannelCommand("hello")).toBe(false);
    expect(isChannelCommand("")).toBe(false);
    expect(isChannelCommand("/")).toBe(false);
    expect(isChannelCommand("/ something")).toBe(false);
    expect(isChannelCommand("/123")).toBe(false);
    expect(isChannelCommand("/A")).toBe(false);
    expect(isChannelCommand("explain /etc/passwd")).toBe(false);
  });
});

describe("dispatchChannelCommand", () => {
  it("/help returns command listing", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/help");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("/status");
    expect(result.text).toContain("/providers");
    expect(result.text).toContain("/help");
    expect(result.text).toContain("/restart");
  });

  it("/status returns gateway state", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/status");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Gateway: running");
    expect(result.text).toContain("Started: 2026-01-01");
    expect(result.text).toContain("Agent: test-agent");
  });

  it("/status includes degraded reasons", async () => {
    const gateway = makeGateway({
      getStatus: () => ({
        state: "degraded",
        degradedReasons: ["provider unreachable", "tool load failed"]
      })
    });
    const result = await dispatchChannelCommand(gateway, session, "/status");
    expect(result.text).toContain("Gateway: degraded");
    expect(result.text).toContain("Degraded: provider unreachable");
    expect(result.text).toContain("Degraded: tool load failed");
  });

  it("/providers lists all profiles", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/providers");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("provider-a");
    expect(result.text).toContain("gpt-4");
    expect(result.text).toContain("provider-b");
    expect(result.text).toContain("claude-sonnet");
  });

  it("/providers with empty list", async () => {
    const gateway = makeGateway({ listProviderProfiles: () => [] });
    const result = await dispatchChannelCommand(gateway, session, "/providers");
    expect(result.text).toContain("No provider profiles configured");
  });

  it("/provider <id> queues switch", async () => {
    const switchFn = vi.fn();
    const gateway = makeGateway({ queueSessionProviderSwitch: switchFn });
    const result = await dispatchChannelCommand(gateway, session, "/provider provider-b");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(switchFn).toHaveBeenCalledWith("session:telegram:wk:chat-1", "provider-b");
    expect(result.text).toContain("Provider queued");
    expect(result.text).toContain("provider-b");
  });

  it("/provider without id returns usage error", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/provider ");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Usage");
  });

  it("/provider with invalid id returns error", async () => {
    const gateway = makeGateway({
      queueSessionProviderSwitch: () => {
        throw new Error("Unknown provider profile: bad-id");
      }
    });
    const result = await dispatchChannelCommand(gateway, session, "/provider bad-id");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Unknown provider profile");
  });

  it("/session shows current session info", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/session");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("session:telegram:wk:chat-1");
    expect(result.text).toContain("provider-a");
  });

  it("/session with no state", async () => {
    const gateway = makeGateway({ getSessionState: () => null });
    const result = await dispatchChannelCommand(gateway, session, "/session");
    expect(result.text).toContain("no state");
  });

  it("/session shows pending provider when set", async () => {
    const gateway = makeGateway({
      getSessionState: () => ({
        activeProviderId: "provider-a",
        pendingProviderId: "provider-b"
      })
    });
    const result = await dispatchChannelCommand(gateway, session, "/session");
    expect(result.text).toContain("Pending: provider-b");
  });

  it("/sessions lists all sessions", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/sessions");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("session:telegram:wk:chat-1");
    expect(result.text).toContain("provider-a");
    expect(result.text).toContain("messages=5");
  });

  it("/sessions marks current session", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/sessions");
    expect(result.text).toContain("* session:telegram:wk:chat-1");
  });

  it("/sessions with empty list", async () => {
    const gateway = makeGateway({ listSessionSnapshots: () => [] });
    const result = await dispatchChannelCommand(gateway, session, "/sessions");
    expect(result.text).toContain("No active sessions");
  });

  it("/new clears current session", async () => {
    const deleteSessionFn = vi.fn().mockReturnValue({ ok: true, message: "cleared" });
    const gateway = makeGateway({ deleteSession: deleteSessionFn });
    const result = await dispatchChannelCommand(gateway, session, "/new");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Started new session");
    expect(deleteSessionFn).toHaveBeenCalledWith("session:telegram:wk:chat-1");
  });

  it("/tools lists loaded tools", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/tools");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("shell");
    expect(result.text).toContain("file");
    expect(result.text).toContain("web");
  });

  it("/tools with none loaded", async () => {
    const gateway = makeGateway({ listLoadedToolNames: () => [] });
    const result = await dispatchChannelCommand(gateway, session, "/tools");
    expect(result.text).toContain("No tools loaded");
  });

  it("/tool <name> runs tool and returns output", async () => {
    const runToolFn = vi.fn().mockResolvedValue({
      toolName: "shell",
      ok: true,
      output: "total 42"
    });
    const gateway = makeGateway({ runTool: runToolFn });
    const result = await dispatchChannelCommand(gateway, session, '/tool shell {"command":"ls"}');
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(runToolFn).toHaveBeenCalledWith({
      sessionId: "session:telegram:wk:chat-1",
      toolName: "shell",
      input: { command: "ls" }
    });
    expect(result.text).toContain("total 42");
  });

  it("/tool <name> without json uses empty object", async () => {
    const runToolFn = vi.fn().mockResolvedValue({
      toolName: "file",
      ok: true,
      output: "done"
    });
    const gateway = makeGateway({ runTool: runToolFn });
    await dispatchChannelCommand(gateway, session, "/tool file");
    expect(runToolFn).toHaveBeenCalledWith({
      sessionId: "session:telegram:wk:chat-1",
      toolName: "file",
      input: {}
    });
  });

  it("/tool with invalid json", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/tool shell {bad}");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Invalid JSON");
  });

  it("/tool without name", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/tool ");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Usage");
  });

  it("/tool returns error result", async () => {
    const gateway = makeGateway({
      runTool: async () => ({
        toolName: "shell",
        ok: false,
        error: {
          code: "execution_error" as const,
          message: "command failed",
          issues: [{ path: "command", message: "not found" }]
        }
      })
    });
    const result = await dispatchChannelCommand(gateway, session, "/tool shell");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("execution_error");
    expect(result.text).toContain("command failed");
    expect(result.text).toContain("not found");
  });

  it("/restart succeeds", async () => {
    const restartFn = vi.fn().mockResolvedValue({
      ok: true,
      code: "allowed",
      message: "ok"
    });
    const gateway = makeGateway({ requestRestart: restartFn });
    const result = await dispatchChannelCommand(gateway, session, "/restart");
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Restart initiated");
    expect(restartFn).toHaveBeenCalledWith({
      intent: "manual",
      reason: "/restart command from channel"
    });
  });

  it("/restart blocked", async () => {
    const gateway = makeGateway({
      requestRestart: async () => ({
        ok: false,
        code: "budget_exceeded" as const,
        message: "too many restarts",
        intent: "manual" as const,
        dryRun: false
      })
    });
    const result = await dispatchChannelCommand(gateway, session, "/restart");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Restart blocked");
    expect(result.text).toContain("too many restarts");
  });

  it("/restart handles thrown error", async () => {
    const gateway = makeGateway({
      requestRestart: async () => {
        throw new Error("restart failed internally");
      }
    });
    const result = await dispatchChannelCommand(gateway, session, "/restart");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("restart failed internally");
  });

  it("unrecognized command returns handled=false", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "/unknown");
    expect(result.handled).toBe(false);
    expect(result.text).toBe("");
  });

  it("regular text returns handled=false", async () => {
    const result = await dispatchChannelCommand(makeGateway(), session, "hello world");
    expect(result.handled).toBe(false);
  });
});
