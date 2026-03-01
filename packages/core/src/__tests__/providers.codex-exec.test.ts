import { describe, expect, it, vi } from "vitest";
import { CodexExecAdapter } from "../providers/codex-exec.js";
import type { ProviderProfile } from "../providers/types.js";

const profile: ProviderProfile = {
  id: "openai-codex",
  adapterId: "codex-exec",
  kind: "openai-codex",
  model: "gpt-4.1-mini",
  authProfileId: "openai-codex:default"
};

describe("codex exec adapter", () => {
  it("reports healthy probe when Codex CLI is logged in", async () => {
    const runner = vi.fn(async () => ({
      stdout: "Logged in using ChatGPT\n",
      stderr: ""
    }));
    const adapter = new CodexExecAdapter(runner);

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => null,
      timeoutMs: 1000
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("ok");
    expect(runner).toHaveBeenCalledOnce();
  });

  it("returns missing_auth when Codex CLI is not logged in", async () => {
    const runner = vi.fn(async () => ({
      stdout: "Not logged in\n",
      stderr: ""
    }));
    const adapter = new CodexExecAdapter(runner);

    const result = await adapter.probe(profile, {
      resolveBearerToken: () => null,
      timeoutMs: 1000
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_auth");
  });

  it("maps codex JSONL output into normalized response events", async () => {
    const runner = vi.fn(async () => ({
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"hello\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}"
      ].join("\n"),
      stderr: ""
    }));
    const adapter = new CodexExecAdapter(runner);

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
          content: "Say hello",
          createdAt: new Date().toISOString()
        }
      ],
      resolveBearerToken: () => null,
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

    expect(eventTypes).toEqual(["response.delta", "usage.updated", "response.completed"]);
    expect(deltas.join("")).toBe("hello");
    expect(completedText).toBe("hello");
    expect(completedTotalTokens).toBe(16);
  });

  it("streams chunked stdout without duplicating completed item text", async () => {
    const runner = vi.fn(async (params: any) => {
      params.onStdoutData?.(
        "{\"type\":\"item.delta\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"delta\":\"hel\"}}\n" +
          "{\"type\":\"item.delta\","
      );
      params.onStdoutData?.(
        "\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"delta\":\"lo\"}}\n" +
          "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"hello\"}}\n" +
          "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}\n"
      );
      return {
        stdout: "",
        stderr: ""
      };
    });
    const adapter = new CodexExecAdapter(runner);

    const eventTypes: string[] = [];
    const deltas: string[] = [];
    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Say hello",
          createdAt: new Date().toISOString()
        }
      ],
      resolveBearerToken: () => null,
      emit: (event) => {
        eventTypes.push(event.type);
        if (event.type === "response.delta") {
          deltas.push(event.payload.text ?? "");
        }
      }
    });

    expect(eventTypes).toEqual(["response.delta", "response.delta", "usage.updated", "response.completed"]);
    expect(deltas.join("")).toBe("hello");
  });

  it("deduplicates snapshot-style response.output_text.delta and item.completed", async () => {
    const runner = vi.fn(async () => ({
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}",
        "{\"type\":\"response.output_text.delta\",\"item_id\":\"i-1\",\"delta\":\"When debugg\"}",
        "{\"type\":\"response.output_text.delta\",\"item_id\":\"i-1\",\"delta\":\"When debugging, I usually do four things.\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"When debugging, I usually do four things.\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}"
      ].join("\n"),
      stderr: ""
    }));
    const adapter = new CodexExecAdapter(runner);

    const deltas: string[] = [];
    let completedText = "";
    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Say one line",
          createdAt: new Date().toISOString()
        }
      ],
      resolveBearerToken: () => null,
      emit: (event) => {
        if (event.type === "response.delta") {
          deltas.push(event.payload.text ?? "");
        }
        if (event.type === "response.completed") {
          completedText = event.payload.text ?? "";
        }
      }
    });

    expect(deltas.join("")).toBe("When debugging, I usually do four things.");
    expect(completedText).toBe("When debugging, I usually do four things.");
  });

  it("deduplicates item.completed when prior response.output_text.delta has no item_id", async () => {
    const runner = vi.fn(async () => ({
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}",
        "{\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-2\",\"type\":\"agent_message\",\"text\":\"hello\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":12,\"output_tokens\":4}}"
      ].join("\n"),
      stderr: ""
    }));
    const adapter = new CodexExecAdapter(runner);

    const deltas: string[] = [];
    let completedText = "";
    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Say hello",
          createdAt: new Date().toISOString()
        }
      ],
      resolveBearerToken: () => null,
      emit: (event) => {
        if (event.type === "response.delta") {
          deltas.push(event.payload.text ?? "");
        }
        if (event.type === "response.completed") {
          completedText = event.payload.text ?? "";
        }
      }
    });

    expect(deltas.join("")).toBe("hello");
    expect(completedText).toBe("hello");
  });

  it("fails fast and emits provider.error when codex exec fails", async () => {
    const runner = vi.fn(async () => {
      throw new Error("codex exec failed");
    });
    const adapter = new CodexExecAdapter(runner);

    const eventTypes: string[] = [];
    await expect(
      adapter.runTurn({
        sessionId: "s-1",
        providerId: profile.id,
        profile,
        messages: [
          {
            role: "user",
            content: "test",
            createdAt: new Date().toISOString()
          }
        ],
        resolveBearerToken: () => null,
        emit: (event) => {
          eventTypes.push(event.type);
        }
      })
    ).rejects.toThrow("codex exec failed");

    expect(eventTypes).toContain("provider.error");
  });

  it("passes images to codex exec in the same turn call", async () => {
    const imgB64 = Buffer.from("fake-image").toString("base64");
    const runner = vi.fn(async (params: any) => {
      const args: string[] = Array.isArray(params.args) ? params.args : [];
      const imageFlagIndex = args.indexOf("--image");
      expect(imageFlagIndex).toBeGreaterThanOrEqual(0);
      const imagePath = args[imageFlagIndex + 1];
      expect(typeof imagePath).toBe("string");
      if (typeof imagePath !== "string") {
        throw new Error("Missing image path argument");
      }
      expect(imagePath.endsWith(".png")).toBe(true);
      return {
        stdout: [
          "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"ok\"}}",
          "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}"
        ].join("\n"),
        stderr: ""
      };
    });
    const adapter = new CodexExecAdapter(runner);

    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Describe this image",
          createdAt: new Date().toISOString()
        }
      ],
      inputImages: [
        {
          mimeType: "image/png",
          dataBase64: imgB64
        }
      ],
      resolveBearerToken: () => null,
      emit: () => undefined
    });

    expect(runner).toHaveBeenCalledOnce();
  });

  it("uses resolved persisted image refs when inputImages are not provided", async () => {
    const imgB64 = Buffer.from("persisted-image").toString("base64");
    const runner = vi.fn(async (params: any) => {
      const args: string[] = Array.isArray(params.args) ? params.args : [];
      const imageFlagIndex = args.indexOf("--image");
      expect(imageFlagIndex).toBeGreaterThanOrEqual(0);
      const imagePath = args[imageFlagIndex + 1];
      expect(typeof imagePath).toBe("string");
      if (typeof imagePath !== "string") {
        throw new Error("Missing image path argument");
      }
      expect(imagePath.endsWith(".png")).toBe(true);
      return {
        stdout: [
          "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"ok\"}}",
          "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}"
        ].join("\n"),
        stderr: ""
      };
    });
    const adapter = new CodexExecAdapter(runner);
    const resolveInputImageRef = vi.fn(() => ({
      mimeType: "image/png",
      dataBase64: imgB64
    }));

    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "Describe this image",
          createdAt: new Date().toISOString(),
          imageRefs: [
            {
              id: "img_1",
              mimeType: "image/png",
              sha256: "a".repeat(64),
              bytes: 12,
              path: ".drost/media/test/a.png"
            }
          ]
        }
      ],
      resolveInputImageRef,
      resolveBearerToken: () => null,
      emit: () => undefined
    });

    expect(resolveInputImageRef).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("adds an explicit image-analysis user line for image-only turns", async () => {
    const imgB64 = Buffer.from("fake-image").toString("base64");
    const runner = vi.fn(async (params: any) => {
      const args: string[] = Array.isArray(params.args) ? params.args : [];
      const promptArg = args[args.length - 1];
      expect(typeof promptArg).toBe("string");
      if (typeof promptArg !== "string") {
        throw new Error("Missing prompt arg");
      }
      expect(promptArg).toContain("USER: Analyze the attached image(s).");
      return {
        stdout: [
          "{\"type\":\"item.completed\",\"item\":{\"id\":\"i-1\",\"type\":\"agent_message\",\"text\":\"ok\"}}",
          "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}"
        ].join("\n"),
        stderr: ""
      };
    });
    const adapter = new CodexExecAdapter(runner);

    await adapter.runTurn({
      sessionId: "s-1",
      providerId: profile.id,
      profile,
      messages: [
        {
          role: "user",
          content: "old context",
          createdAt: new Date().toISOString()
        },
        {
          role: "assistant",
          content: "old answer",
          createdAt: new Date().toISOString()
        },
        {
          role: "user",
          content: "",
          createdAt: new Date().toISOString()
        }
      ],
      inputImages: [
        {
          mimeType: "image/png",
          dataBase64: imgB64
        }
      ],
      resolveBearerToken: () => null,
      emit: () => undefined
    });

    expect(runner).toHaveBeenCalledOnce();
  });
});
