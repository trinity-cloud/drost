import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, RESTART_EXIT_CODE } from "../index.js";

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-restart-policy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway restart policy", () => {
  it("allows self-mod restarts without approval handler", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir
    });

    await gateway.start();
    const result = await gateway.requestRestart({
      intent: "self_mod",
      dryRun: true,
      reason: "tool-triggered"
    });

    expect(result && typeof result === "object" && "ok" in result ? result.ok : false).toBe(true);
    expect(result && typeof result === "object" && "code" in result ? result.code : "").toBe("allowed");
    expect(gateway.getStatus().state).toBe("running");
    await gateway.stop();
  });

  it("ignores strict git checkpoint policy and still allows self-mod dry-run", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      restartPolicy: {
        approval: async () => ({ approved: true }),
        gitSafety: {
          enabled: true,
          strict: true
        }
      }
    });

    await gateway.start();
    const result = await gateway.requestRestart({
      intent: "self_mod",
      dryRun: true
    });

    expect(result && typeof result === "object" && "ok" in result ? result.ok : false).toBe(true);
    expect(result && typeof result === "object" && "code" in result ? result.code : "").toBe("allowed");
    await gateway.stop();
  });

  it("executes approved self-mod restarts", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway(
      {
        workspaceDir,
        restartPolicy: {
          approval: async () => ({ approved: true }),
          gitSafety: {
            enabled: false
          }
        }
      },
      {
        exit: (code) => {
          throw new ExitSignal(code);
        }
      }
    );

    await gateway.start();

    let caught: ExitSignal | null = null;
    try {
      await gateway.requestRestart({
        intent: "self_mod",
        reason: "agent requested restart"
      });
    } catch (error) {
      if (error instanceof ExitSignal) {
        caught = error;
      } else {
        throw error;
      }
    }

    expect(caught?.code).toBe(RESTART_EXIT_CODE);
    expect(gateway.getStatus().state).toBe("stopped");
  });
});
