import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type GatewayRuntimeEvent } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-events-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway runtime event envelope", () => {
  it("emits lifecycle, restart, and reload events", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      restartPolicy: {
        gitSafety: {
          enabled: false
        }
      }
    });

    const events: GatewayRuntimeEvent[] = [];
    const unsubscribe = gateway.onRuntimeEvent((event) => {
      events.push(event);
    });

    await gateway.start();
    const restartResult = await gateway.requestRestart({
      intent: "manual",
      dryRun: true,
      reason: "test"
    });
    expect(restartResult && typeof restartResult === "object" && "ok" in restartResult ? restartResult.ok : false).toBe(true);

    const reload = await gateway.reloadConfig({
      health: {
        enabled: false
      }
    });
    expect(reload.applied).toContain("health");
    await gateway.stop();
    unsubscribe();

    const types = events.map((event) => event.type);
    expect(types).toContain("gateway.starting");
    expect(types).toContain("gateway.started");
    expect(types).toContain("gateway.restart.requested");
    expect(types).toContain("gateway.restart.validated");
    expect(types).toContain("gateway.config.reloaded");
    expect(types).toContain("gateway.stopping");
    expect(types).toContain("gateway.stopped");
    expect(events.every((event) => typeof event.timestamp === "string")).toBe(true);
    expect(events.every((event) => event.payload && typeof event.payload === "object")).toBe(true);
  });
});
