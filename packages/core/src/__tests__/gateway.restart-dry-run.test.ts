import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-restart-dry-run-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway restart dry-run", () => {
  it("validates restart policy without stopping process", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
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
    });

    await gateway.start();
    const first = await gateway.requestRestart({
      intent: "self_mod",
      dryRun: true
    });
    expect(first && typeof first === "object" && "ok" in first ? first.ok : false).toBe(true);

    const second = await gateway.requestRestart({
      intent: "self_mod",
      dryRun: true
    });
    expect(second && typeof second === "object" && "ok" in second ? second.ok : false).toBe(true);
    expect(gateway.getStatus().state).toBe("running");
    await gateway.stop();
  });
});
