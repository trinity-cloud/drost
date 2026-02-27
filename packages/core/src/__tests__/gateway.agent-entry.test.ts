import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedStreamEvent, ProviderAdapter, ProviderProbeContext, ProviderProbeResult, ProviderProfile, ProviderTurnRequest } from "../index.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-agent-entry-"));
  tempDirs.push(dir);
  return dir;
}

class EchoProviderAdapter implements ProviderAdapter {
  readonly id = "test-echo-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    const lastUserMessage =
      request.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content ?? "";
    const text = `echo:${lastUserMessage}`;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway agent entry loading", () => {
  it("loads agent module tools and executes agent hooks", async () => {
    const rootDir = makeTempDir();
    const workspaceDir = path.join(rootDir, "workspace");
    const toolDirectory = path.join(workspaceDir, "tools");
    const sessionDirectory = path.join(workspaceDir, "sessions");
    const agentDir = path.join(rootDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentDir, "hooks.ts"),
      [
        "export function prefixInput(input: string): string {",
        "  return `[agent-prefix] ${input}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const agentEntry = path.join(agentDir, "index.ts");
    fs.writeFileSync(
      agentEntry,
      [
        "import fs from \"node:fs\";",
        "import path from \"node:path\";",
        "import { prefixInput } from \"./hooks\";",
        "",
        "export default {",
        "  name: \"fixture-agent\",",
        "  tools: [",
        "    {",
        "      name: \"agent_echo\",",
        "      description: \"Echo input\",",
        "      execute: async (input) => ({ echoed: input })",
        "    }",
        "  ],",
        "  hooks: {",
        "    onStart: async ({ workspaceDir }) => {",
        "      fs.writeFileSync(path.join(workspaceDir, \"agent-started.txt\"), \"ok\");",
        "    },",
        "    beforeTurn: async ({ input }) => ({",
        "      input: prefixInput(input)",
        "    }),",
        "    afterTurn: async ({ runtime }) => {",
        "      fs.writeFileSync(path.join(runtime.workspaceDir, \"agent-after-turn.txt\"), \"ok\");",
        "    }",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const gateway = createGateway({
      workspaceDir,
      toolDirectory,
      sessionStore: {
        enabled: true,
        directory: sessionDirectory
      },
      agent: {
        entry: agentEntry
      },
      providers: {
        defaultSessionProvider: "echo",
        profiles: [
          {
            id: "echo",
            adapterId: "test-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "unused"
          }
        ],
        adapters: [new EchoProviderAdapter()]
      }
    });

    await gateway.start();
    const status = gateway.getStatus();
    expect(status.agent?.loaded).toBe(true);
    expect(status.agent?.name).toBe("fixture-agent");
    expect(fs.readFileSync(path.join(workspaceDir, "agent-started.txt"), "utf8")).toBe("ok");

    const toolResult = await gateway.runTool({
      sessionId: "local",
      toolName: "agent_echo",
      input: {
        hello: "world"
      }
    });
    expect(toolResult.ok).toBe(true);
    expect((toolResult.output as { echoed?: unknown }).echoed).toEqual({
      hello: "world"
    });

    gateway.ensureSession("local");
    const events: NormalizedStreamEvent[] = [];
    await gateway.runSessionTurn({
      sessionId: "local",
      input: "hello",
      onEvent: (event) => events.push(event)
    });
    expect(events.some((event) => event.type === "response.completed" && event.payload.text?.includes("[agent-prefix] hello"))).toBe(
      true
    );
    expect(fs.readFileSync(path.join(workspaceDir, "agent-after-turn.txt"), "utf8")).toBe("ok");

    await gateway.stop();
  });

  it("marks gateway degraded when configured agent entry file is missing", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      agent: {
        entry: path.join(workspaceDir, "agent", "missing.ts")
      }
    });

    const status = await gateway.start();
    expect(status.state).toBe("degraded");
    expect(status.agent?.loaded).toBe(false);
    expect(status.degradedReasons.some((reason) => reason.includes("Agent entry file not found"))).toBe(true);

    await gateway.stop();
  });
});
