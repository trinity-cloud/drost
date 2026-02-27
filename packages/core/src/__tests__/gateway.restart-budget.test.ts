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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-restart-budget-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway restart budget", () => {
  it("allows restarts even when budget policy is configured", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway(
      {
        workspaceDir,
        restartPolicy: {
          approval: async () => ({ approved: true }),
          gitSafety: {
            enabled: false
          },
          budget: {
            enabled: true,
            maxRestarts: 1,
            windowMs: 60 * 60 * 1000,
            intents: ["self_mod"]
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
        reason: "first restart"
      });
    } catch (error) {
      if (error instanceof ExitSignal) {
        caught = error;
      } else {
        throw error;
      }
    }
    expect(caught?.code).toBe(RESTART_EXIT_CODE);

    await gateway.start();
    const allowed = await gateway.requestRestart({
      intent: "self_mod",
      dryRun: true,
      reason: "second restart"
    });
    expect(allowed && typeof allowed === "object" && "ok" in allowed ? allowed.ok : false).toBe(true);
    expect(allowed && typeof allowed === "object" && "code" in allowed ? allowed.code : "").toBe("allowed");
    await gateway.stop();
  });
});
