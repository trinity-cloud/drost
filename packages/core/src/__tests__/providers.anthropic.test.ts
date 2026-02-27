import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesAdapter } from "../providers/anthropic.js";
import type { ProviderProfile } from "../providers/types.js";

const profile: ProviderProfile = {
  id: "anthropic-main",
  adapterId: "anthropic-messages",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  authProfileId: "anthropic:default"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anthropic messages adapter", () => {
  it("streams deltas and usage updates", async () => {
    const adapter = new AnthropicMessagesAdapter();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}\n\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"from anthropic"}}\n\n'
          )
        );
        controller.enqueue(encoder.encode('data: {"type":"message_delta","usage":{"output_tokens":6}}\n\n'));
        controller.close();
      }
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      )
    );

    const eventTypes: string[] = [];
    const deltas: string[] = [];
    const usageTotals: number[] = [];
    let completedText = "";
    let completedTotalTokens: number | undefined;
    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Say hi",
          createdAt: new Date().toISOString()
        }
      ],
      resolveBearerToken: () => "anthropic-token",
      emit: (event) => {
        eventTypes.push(event.type);
        if (event.type === "response.delta") {
          deltas.push(event.payload.text ?? "");
        }
        if (event.type === "usage.updated") {
          if (typeof event.payload.usage?.totalTokens === "number") {
            usageTotals.push(event.payload.usage.totalTokens);
          }
        }
        if (event.type === "response.completed") {
          completedText = event.payload.text ?? "";
          completedTotalTokens = event.payload.usage?.totalTokens;
        }
      }
    });

    expect(eventTypes).toEqual([
      "usage.updated",
      "response.delta",
      "response.delta",
      "usage.updated",
      "response.completed"
    ]);
    expect(deltas.join("")).toBe("hello from anthropic");
    expect(usageTotals).toEqual([11, 17]);
    expect(completedText).toBe("hello from anthropic");
    expect(completedTotalTokens).toBe(17);
  });

  it("fails fast when auth is missing", async () => {
    const adapter = new AnthropicMessagesAdapter();

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => null,
      timeoutMs: 1000
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_auth");
  });

  it("reports incompatible transport when /v1/messages is unavailable", async () => {
    const adapter = new AnthropicMessagesAdapter();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain" }
        })
      )
    );

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => "anthropic-token",
      timeoutMs: 1000
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("incompatible_transport");
  });

  it("uses bearer auth plus oauth betas for setup-token credentials", async () => {
    const adapter = new AnthropicMessagesAdapter();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "msg_probe",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => "sk-ant-oat01-test-token",
      timeoutMs: 1000
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = (fetchMock.mock.calls as Array<unknown[]>)[0] ?? [];
    const init = (firstCall[1] as { headers?: Record<string, string> } | undefined) ?? {};
    const headers = init.headers ?? {};
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-test-token");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
  });
});
