import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-tool-policy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway tool policy", () => {
  it("denies configured tools and emits policy-denied runtime events", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      toolPolicy: {
        deniedTools: ["shell"]
      }
    });
    const eventTypes: string[] = [];
    gateway.onRuntimeEvent((event) => {
      eventTypes.push(event.type);
    });

    await gateway.start();
    try {
      const result = await gateway.runTool({
        sessionId: "local",
        toolName: "shell",
        input: {
          command: "echo denied"
        }
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("policy_denied");
      expect(eventTypes).toContain("tool.policy.denied");
    } finally {
      await gateway.stop();
    }
  });

  it("applies strict profile defaults unless explicitly allow-listed", async () => {
    const workspaceDir = makeTempDir();
    const blockedGateway = createGateway({
      workspaceDir,
      toolPolicy: {
        profile: "strict"
      }
    });

    await blockedGateway.start();
    try {
      const blocked = await blockedGateway.runTool({
        sessionId: "local",
        toolName: "shell",
        input: {
          command: "echo strict"
        }
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.error?.code).toBe("policy_denied");
    } finally {
      await blockedGateway.stop();
    }

    const allowGateway = createGateway({
      workspaceDir,
      toolPolicy: {
        profile: "strict",
        allowedTools: ["shell"]
      }
    });
    await allowGateway.start();
    try {
      const allowed = await allowGateway.runTool({
        sessionId: "local",
        toolName: "shell",
        input: {
          command: "printf strict-allow"
        }
      });
      expect(allowed.ok).toBe(true);
    } finally {
      await allowGateway.stop();
    }
  });
});
