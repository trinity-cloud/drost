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
});
