import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-plugin-skill-"));
  tempDirs.push(dir);
  return dir;
}

class EchoAdapter implements ProviderAdapter {
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
    const input =
      request.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content ?? "";
    const text = `echo:${input}`;
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway plugins and skills", () => {
  it("loads plugin hooks and injects relevant skills with per-session override", async () => {
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, "plugins");
    const skillsRoot = path.join(workspaceDir, "skills");
    const skillDir = path.join(skillsRoot, "shell-assistant");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });

    const pluginPath = path.join(pluginDir, "prefixer.ts");
    fs.writeFileSync(
      pluginPath,
      [
        "import fs from \"node:fs\";",
        "import path from \"node:path\";",
        "export default {",
        "  id: \"prefixer\",",
        "  hooks: {",
        "    beforeTurn: async ({ input }) => ({ input: `[plugin-prefix] ${input}` }),",
        "    afterTurn: async ({ runtime }) => {",
        "      fs.writeFileSync(path.join(runtime.workspaceDir, \"plugin-after.txt\"), \"ok\", \"utf8\");",
        "    }",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "# Shell Assistant",
        "",
        "Use this skill when the user asks about shell scripts or bash commands.",
        "Include practical command examples and safety checks.",
        ""
      ].join("\n"),
      "utf8"
    );

    const gateway = createGateway({
      workspaceDir,
      plugins: {
        enabled: true,
        modules: [pluginPath],
        trustedRoots: [pluginDir],
        allowlist: ["prefixer"]
      },
      skills: {
        enabled: true,
        roots: [skillsRoot],
        injectionMode: "relevant",
        maxInjected: 2
      },
      providers: {
        defaultSessionProvider: "echo",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "echo",
            adapterId: "test-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "unused"
          }
        ],
        adapters: [new EchoAdapter()]
      }
    });

    await gateway.start();
    try {
      const status = gateway.getStatus();
      expect(status.plugins?.loaded.map((entry) => entry.id)).toContain("prefixer");
      expect(status.skills?.allowed).toBe(1);

      gateway.ensureSession("local");
      await gateway.runSessionTurn({
        sessionId: "local",
        input: "Need a bash shell script for logs",
        onEvent: () => undefined
      });
      const firstResponse =
        gateway
          .getSessionHistory("local")
          .filter((message) => message.role === "assistant")
          .at(-1)?.content ?? "";
      expect(firstResponse).toContain("[plugin-prefix]");
      expect(firstResponse).toContain("[SKILLS CONTEXT]");

      const modeResult = gateway.setSessionSkillInjectionMode("local", "off");
      expect(modeResult.ok).toBe(true);

      await gateway.runSessionTurn({
        sessionId: "local",
        input: "Need bash help again",
        onEvent: () => undefined
      });
      const secondResponse =
        gateway
          .getSessionHistory("local")
          .filter((message) => message.role === "assistant")
          .at(-1)?.content ?? "";
      expect(secondResponse).toContain("[plugin-prefix]");
      expect(secondResponse).not.toContain("[SKILLS CONTEXT]");

      expect(fs.readFileSync(path.join(workspaceDir, "plugin-after.txt"), "utf8")).toBe("ok");
    } finally {
      await gateway.stop();
    }
  });

  it("blocks plugins outside trusted roots", async () => {
    const workspaceDir = makeTempDir();
    const pluginPath = path.join(workspaceDir, "plugin.ts");
    fs.writeFileSync(
      pluginPath,
      [
        "export default {",
        "  id: \"outside\"",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const gateway = createGateway({
      workspaceDir,
      plugins: {
        enabled: true,
        modules: [pluginPath],
        trustedRoots: [path.join(workspaceDir, "trusted-only")]
      }
    });

    await gateway.start();
    try {
      const status = gateway.getStatus();
      expect(status.plugins?.loaded).toHaveLength(0);
      expect(status.plugins?.blocked.some((entry) => entry.reason === "untrusted_path")).toBe(true);
    } finally {
      await gateway.stop();
    }
  });
});
