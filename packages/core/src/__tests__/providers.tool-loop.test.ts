import { describe, expect, it } from "vitest";
import type { AuthStore } from "../auth/store.js";
import { ProviderManager } from "../providers/manager.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";
import type { NormalizedStreamEvent } from "../events.js";

class ToolLoopAdapter implements ProviderAdapter {
  readonly id = "tool-loop";
  turns = 0;
  snapshots: ProviderTurnRequest["messages"][] = [];

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.turns += 1;
    this.snapshots.push(request.messages);

    const hasToolResult = request.messages.some(
      (message) => message.role === "tool" && message.content.startsWith("TOOL_RESULT")
    );

    const text = hasToolResult
      ? "Final answer after tool execution."
      : "TOOL_CALL {\"name\":\"echo_tool\",\"input\":{\"text\":\"hello\"}}";

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

class EndlessToolCallAdapter implements ProviderAdapter {
  readonly id = "endless-tool";
  turns = 0;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.turns += 1;
    const text = "TOOL_CALL {\"name\":\"echo_tool\",\"input\":{\"text\":\"again\"}}";
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

class PrefixedToolCallAdapter implements ProviderAdapter {
  readonly id = "prefixed-tool";
  turns = 0;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.turns += 1;
    const hasToolResult = request.messages.some(
      (message) => message.role === "tool" && message.content.startsWith("TOOL_RESULT")
    );

    const text = hasToolResult
      ? "Final answer after prefixed tool call."
      : [
          "I can run this now.",
          "```json",
          'TOOL_CALL {"name":"echo_tool","input":{"text":"prefixed"}}',
          "```"
        ].join("\n");

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

class SnapshotDeltaAdapter implements ProviderAdapter {
  readonly id = "snapshot-delta";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "When debugg"
      }
    });
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "When debugging, I usually do four things."
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "When debugging, I usually do four things."
      }
    });
  }
}

class NativeToolCallAdapter implements ProviderAdapter {
  readonly id = "native-tool";
  readonly supportsNativeToolCalls = true;
  turns = 0;
  sawAvailableTools = false;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<{ nativeToolCalls?: Array<{ id: string; name: string; input: unknown }> }> {
    this.turns += 1;
    this.sawAvailableTools = Array.isArray(request.availableTools) && request.availableTools.length > 0;
    const hasToolResult = request.messages.some(
      (message) => message.role === "tool" && message.content.startsWith("TOOL_RESULT")
    );
    if (!hasToolResult) {
      return {
        nativeToolCalls: [
          {
            id: "call_native_1",
            name: "echo_tool",
            input: {
              text: "native"
            }
          }
        ]
      };
    }

    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "Final answer from native tool call."
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "Final answer from native tool call."
      }
    });
    return {};
  }
}

class NativeWebEmptyInputAdapter implements ProviderAdapter {
  readonly id = "native-web-empty";
  readonly supportsNativeToolCalls = true;
  turns = 0;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<{ nativeToolCalls?: Array<{ id: string; name: string; input: unknown }> }> {
    this.turns += 1;
    const hasToolResult = request.messages.some(
      (message) => message.role === "tool" && message.content.startsWith("TOOL_RESULT")
    );
    if (!hasToolResult) {
      return {
        nativeToolCalls: [
          {
            id: "call_web_1",
            name: "web",
            input: {}
          }
        ]
      };
    }

    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "Web call complete."
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: "Web call complete."
      }
    });
    return {};
  }
}

class EndlessValidationNativeAdapter implements ProviderAdapter {
  readonly id = "native-validation-loop";
  readonly supportsNativeToolCalls = true;
  turns = 0;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(_request: ProviderTurnRequest): Promise<{ nativeToolCalls?: Array<{ id: string; name: string; input: unknown }> }> {
    this.turns += 1;
    return {
      nativeToolCalls: [
        {
          id: `call_validation_${this.turns}`,
          name: "web",
          input: {}
        }
      ]
    };
  }
}

class NativeWebFallbackAdapter implements ProviderAdapter {
  readonly id = "native-web-fallback";
  readonly supportsNativeToolCalls = true;
  turns = 0;

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.turns += 1;
    const hasToolResult = request.messages.some(
      (message) => message.role === "tool" && message.content.startsWith("TOOL_RESULT")
    );
    const text = hasToolResult ? "Fresh results after auto web tool." : "I will answer from memory.";
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

function authStore(): AuthStore {
  return {
    version: 1,
    profiles: {
      "auth:default": {
        id: "auth:default",
        provider: "openai-compatible",
        credential: {
          type: "api_key",
          value: "token"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  };
}

function profile(adapterId: string): ProviderProfile {
  return {
    id: "provider",
    adapterId,
    kind: "openai-compatible",
    baseUrl: "https://example.com",
    model: "demo",
    authProfileId: "auth:default"
  };
}

describe("provider tool loop", () => {
  it("runs tool call loops and returns final assistant output", async () => {
    const adapter = new ToolLoopAdapter();
    const manager = new ProviderManager({
      profiles: [profile("tool-loop")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    const events: NormalizedStreamEvent[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "please use a tool",
      authStore: authStore(),
      availableToolNames: ["echo_tool"],
      onEvent: (event) => {
        events.push(event);
      },
      runTool: async (request) => {
        toolCalls.push({
          name: request.toolName,
          input: request.input
        });
        request.onEvent({
          type: "tool.call.started",
          sessionId: request.sessionId,
          providerId: request.providerId,
          timestamp: new Date().toISOString(),
          payload: {
            toolName: request.toolName
          }
        });
        request.onEvent({
          type: "tool.call.completed",
          sessionId: request.sessionId,
          providerId: request.providerId,
          timestamp: new Date().toISOString(),
          payload: {
            toolName: request.toolName,
            metadata: {
              ok: true
            }
          }
        });
        return {
          ok: true,
          output: {
            echoed: request.input
          }
        };
      }
    });

    expect(adapter.turns).toBe(2);
    expect(toolCalls).toEqual([
      {
        name: "echo_tool",
        input: {
          text: "hello"
        }
      }
    ]);

    const history = manager.getSessionHistory("s-1");
    expect(history.length).toBe(3);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("tool");
    expect(history[1]?.content).toContain("TOOL_RESULT");
    expect(history[2]?.role).toBe("assistant");
    expect(history[2]?.content).toContain("Final answer after tool execution.");

    const started = events.filter((event) => event.type === "tool.call.started");
    const completed = events.filter((event) => event.type === "tool.call.completed");
    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);
  });

  it("halts when tool-call budget is exceeded", async () => {
    const adapter = new EndlessToolCallAdapter();
    const manager = new ProviderManager({
      profiles: [profile("endless-tool")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    let toolCallCount = 0;
    const events: NormalizedStreamEvent[] = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "keep calling tools",
      authStore: authStore(),
      availableToolNames: ["echo_tool"],
      maxToolCalls: 1,
      onEvent: (event) => {
        events.push(event);
      },
      runTool: async () => {
        toolCallCount += 1;
        return {
          ok: true,
          output: {
            ok: true
          }
        };
      }
    });

    expect(toolCallCount).toBe(1);
    expect(adapter.turns).toBe(2);
    expect(events.some((event) => event.type === "provider.error")).toBe(true);

    const history = manager.getSessionHistory("s-1");
    expect(history.length).toBe(3);
    expect(history[2]?.role).toBe("assistant");
    expect(history[2]?.content).toContain("Tool call budget exceeded");
  });

  it("parses prefixed and fenced tool-call output", async () => {
    const adapter = new PrefixedToolCallAdapter();
    const manager = new ProviderManager({
      profiles: [profile("prefixed-tool")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "run with prefix",
      authStore: authStore(),
      availableToolNames: ["echo_tool"],
      onEvent: () => {},
      runTool: async (request) => {
        toolCalls.push({ name: request.toolName, input: request.input });
        return {
          ok: true,
          output: { echoed: request.input }
        };
      }
    });

    expect(adapter.turns).toBe(2);
    expect(toolCalls).toEqual([
      {
        name: "echo_tool",
        input: {
          text: "prefixed"
        }
      }
    ]);
  });

  it("deduplicates snapshot-style provider deltas in stored assistant history", async () => {
    const adapter = new SnapshotDeltaAdapter();
    const manager = new ProviderManager({
      profiles: [profile("snapshot-delta")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    await manager.runTurn({
      sessionId: "s-1",
      input: "test snapshots",
      authStore: authStore(),
      onEvent: () => {}
    });

    const history = manager.getSessionHistory("s-1");
    expect(history.length).toBe(2);
    expect(history[1]?.role).toBe("assistant");
    expect(history[1]?.content).toBe("When debugging, I usually do four things.");
    expect(history[1]?.content).not.toContain("When debuggWhen debugging");
  });

  it("runs provider-native tool calls when adapter returns native call descriptors", async () => {
    const adapter = new NativeToolCallAdapter();
    const manager = new ProviderManager({
      profiles: [profile("native-tool")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "use native tool calling",
      authStore: authStore(),
      availableToolNames: ["echo_tool"],
      availableTools: [
        {
          name: "echo_tool",
          description: "Echo text",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string"
              }
            },
            required: ["text"],
            additionalProperties: false
          }
        }
      ],
      onEvent: () => {},
      runTool: async (request) => {
        toolCalls.push({ name: request.toolName, input: request.input });
        return {
          ok: true,
          output: {
            echoed: request.input
          }
        };
      }
    });

    expect(adapter.turns).toBe(2);
    expect(adapter.sawAvailableTools).toBe(true);
    expect(toolCalls).toEqual([
      {
        name: "echo_tool",
        input: {
          text: "native"
        }
      }
    ]);

    const history = manager.getSessionHistory("s-1");
    expect(history.length).toBe(4);
    expect(history[1]?.role).toBe("tool");
    expect(history[1]?.content).toContain("TOOL_NATIVE_CALLS");
    expect(history[2]?.role).toBe("tool");
    expect(history[2]?.content).toContain("TOOL_RESULT");
    expect(history[2]?.content).toContain("call_native_1");
    expect(history[3]?.role).toBe("assistant");
    expect(history[3]?.content).toContain("Final answer from native tool call.");
  });

  it("normalizes empty native web inputs to search calls using the latest user message", async () => {
    const adapter = new NativeWebEmptyInputAdapter();
    const manager = new ProviderManager({
      profiles: [profile("native-web-empty")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "search for today's news on Iran",
      authStore: authStore(),
      availableToolNames: ["web"],
      availableTools: [
        {
          name: "web",
          inputSchema: {
            type: "object",
            additionalProperties: true
          }
        }
      ],
      onEvent: () => {},
      runTool: async (request) => {
        toolCalls.push({
          name: request.toolName,
          input: request.input
        });
        return {
          ok: true,
          output: {
            ok: true
          }
        };
      }
    });

    expect(toolCalls).toEqual([
      {
        name: "web",
        input: {
          action: "search",
          query: "search for today's news on Iran"
        }
      }
    ]);
  });

  it("auto-runs web search once when a native provider emits no tool call for a fresh query", async () => {
    const adapter = new NativeWebFallbackAdapter();
    const manager = new ProviderManager({
      profiles: [profile("native-web-fallback")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    await manager.runTurn({
      sessionId: "s-1",
      input: "Can you search for today's news on Iran?",
      authStore: authStore(),
      availableToolNames: ["web"],
      availableTools: [
        {
          name: "web",
          inputSchema: {
            type: "object",
            additionalProperties: true
          }
        }
      ],
      onEvent: () => {},
      runTool: async (request) => {
        toolCalls.push({
          name: request.toolName,
          input: request.input
        });
        return {
          ok: true,
          output: {
            headlines: 5
          }
        };
      }
    });

    expect(adapter.turns).toBe(2);
    expect(toolCalls).toEqual([
      {
        name: "web",
        input: {
          action: "search",
          query: "Can you search for today's news on Iran?"
        }
      }
    ]);

    const history = manager.getSessionHistory("s-1");
    expect(history[1]?.role).toBe("tool");
    expect(history[1]?.content).toContain("TOOL_NATIVE_CALLS");
    expect(history[2]?.role).toBe("tool");
    expect(history[2]?.content).toContain("TOOL_RESULT");
    expect(history[3]?.role).toBe("assistant");
    expect(history[3]?.content).toContain("Fresh results after auto web tool.");
  });

  it("stops repeated validation-error native tool loops early", async () => {
    const adapter = new EndlessValidationNativeAdapter();
    const manager = new ProviderManager({
      profiles: [profile("native-validation-loop")],
      adapters: [adapter]
    });
    manager.ensureSession("s-1", "provider");

    let runToolCalls = 0;
    await manager.runTurn({
      sessionId: "s-1",
      input: "search iran news",
      authStore: authStore(),
      availableToolNames: ["web"],
      availableTools: [
        {
          name: "web",
          inputSchema: {
            type: "object",
            additionalProperties: true
          }
        }
      ],
      onEvent: () => {},
      runTool: async () => {
        runToolCalls += 1;
        return {
          ok: false,
          error: {
            code: "validation_error",
            message: "Invalid discriminator value. Expected 'fetch' | 'search'",
            issues: [
              {
                path: "action",
                message: "Invalid discriminator value. Expected 'fetch' | 'search'",
                code: "invalid_union_discriminator"
              }
            ]
          }
        };
      }
    });

    expect(runToolCalls).toBe(3);
    const history = manager.getSessionHistory("s-1");
    const lastAssistant = history.filter((message) => message.role === "assistant").at(-1);
    expect(lastAssistant?.content).toContain("Stopped repeated validation-error tool loop (web)");
  });
});
