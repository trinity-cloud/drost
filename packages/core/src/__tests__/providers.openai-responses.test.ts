import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesAdapter } from "../providers/openai-responses.js";
import type { ProviderProfile } from "../providers/types.js";

const profile: ProviderProfile = {
  id: "openai-main",
  adapterId: "openai-responses",
  kind: "openai",
  baseUrl: "https://api.openai.com",
  model: "gpt-4.1-mini",
  authProfileId: "openai:default"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openai responses adapter", () => {
  it("streams deltas and emits usage/completed events", async () => {
    const adapter = new OpenAIResponsesAdapter();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"hello "}\n\n')
        );
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"world"}\n\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\n\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
      resolveBearerToken: () => "sk-test",
      emit: (event) => {
        eventTypes.push(event.type);
        if (event.type === "response.delta") {
          deltas.push(event.payload.text ?? "");
        }
        if (event.type === "response.completed") {
          completedText = event.payload.text ?? "";
          completedTotalTokens = event.payload.usage?.totalTokens;
        }
      }
    });

    expect(eventTypes).toEqual(["response.delta", "response.delta", "usage.updated", "response.completed"]);
    expect(deltas.join("")).toBe("hello world");
    expect(completedText).toBe("hello world");
    expect(completedTotalTokens).toBe(8);
  });

  it("reports incompatible transport when /v1/responses is unavailable", async () => {
    const adapter = new OpenAIResponsesAdapter();

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
      resolveBearerToken: () => "sk-test",
      timeoutMs: 1000
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("incompatible_transport");
  });

  it("fails fast when auth is missing", async () => {
    const adapter = new OpenAIResponsesAdapter();

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => null,
      timeoutMs: 1000
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_auth");
  });

  it("supports baseUrl values that already include /v1", async () => {
    const adapter = new OpenAIResponsesAdapter();
    const profileWithVersion: ProviderProfile = {
      ...profile,
      id: "xai",
      kind: "openai-compatible",
      baseUrl: "https://api.x.ai/v1"
    };

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "bad request"
          }
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.probe(profileWithVersion, {
      resolveBearerToken: () => "xai-test",
      timeoutMs: 1000
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = (fetchMock.mock.calls as Array<unknown[]>)[0] ?? [];
    const firstUrl = String(firstCall[0] ?? "");
    expect(firstUrl).toBe("https://api.x.ai/v1/responses");
  });
});
