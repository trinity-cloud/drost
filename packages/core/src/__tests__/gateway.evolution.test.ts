import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-evolution-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway evolution transaction runner", () => {
  it("runs evolution steps and persists outputs", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      evolution: {
        enabled: true
      }
    });
    await gateway.start();

    const result = await gateway.runEvolution({
      sessionId: "local",
      summary: "write marker file",
      steps: [
        {
          toolName: "file",
          input: {
            action: "write",
            path: "notes/evolution.txt",
            content: "evolved"
          }
        },
        {
          toolName: "file",
          input: {
            action: "read",
            path: "notes/evolution.txt"
          }
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("completed");
    expect(result.transactionId).toMatch(/^evo_/);
    expect(result.stepResults?.length).toBe(2);
    expect(fs.readFileSync(path.join(workspaceDir, "notes", "evolution.txt"), "utf8")).toBe("evolved");

    await gateway.stop();
  });

  it("returns busy when another evolution transaction is in flight", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      evolution: {
        enabled: true
      }
    });
    await gateway.start();

    const firstPromise = gateway.runEvolution({
      sessionId: "local",
      steps: [
        {
          toolName: "shell",
          input: {
            command: "sleep 0.2"
          }
        }
      ]
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    const second = await gateway.runEvolution({
      sessionId: "local",
      steps: [
        {
          toolName: "file",
          input: {
            action: "write",
            path: "notes/blocked.txt",
            content: "blocked"
          }
        }
      ]
    });

    expect(second.ok).toBe(false);
    expect(second.code).toBe("busy");
    expect(typeof second.activeTransactionId).toBe("string");

    const first = await firstPromise;
    expect(first.ok).toBe(true);

    const third = await gateway.runEvolution({
      sessionId: "local",
      steps: [
        {
          toolName: "file",
          input: {
            action: "write",
            path: "notes/after.txt",
            content: "after"
          }
        }
      ]
    });
    expect(third.ok).toBe(true);

    await gateway.stop();
  });

  it("releases lock after failed step", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      evolution: {
        enabled: true
      }
    });
    await gateway.start();

    const failed = await gateway.runEvolution({
      sessionId: "local",
      steps: [
        {
          toolName: "does-not-exist",
          input: {}
        }
      ]
    });
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("failed");

    const recovered = await gateway.runEvolution({
      sessionId: "local",
      steps: [
        {
          toolName: "file",
          input: {
            action: "write",
            path: "notes/recovered.txt",
            content: "ok"
          }
        }
      ]
    });
    expect(recovered.ok).toBe(true);

    await gateway.stop();
  });
});
