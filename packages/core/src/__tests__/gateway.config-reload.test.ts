import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-config-reload-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway config reload", () => {
  it("applies safe reload fields and rejects restart-required fields", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      health: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        path: "/healthz"
      }
    });

    await gateway.start();
    expect(gateway.getStatus().healthUrl).toContain("/healthz");

    const safeReload = await gateway.reloadConfig({
      health: {
        path: "/livez"
      }
    });
    expect(safeReload.ok).toBe(true);
    expect(safeReload.applied).toContain("health");
    expect(gateway.getStatus().healthUrl).toContain("/livez");

    const unsafeReload = await gateway.reloadConfig({
      workspaceDir: path.join(workspaceDir, "other")
    });
    expect(unsafeReload.ok).toBe(false);
    expect(unsafeReload.restartRequired).toBe(true);
    expect(unsafeReload.rejected[0]?.path).toBe("workspaceDir");

    const agentReload = await gateway.reloadConfig({
      agent: {
        entry: path.join(workspaceDir, "agent", "index.ts")
      }
    });
    expect(agentReload.ok).toBe(false);
    expect(agentReload.restartRequired).toBe(true);
    expect(agentReload.rejected.some((item) => item.path === "agent")).toBe(true);

    await gateway.stop();
  });
});
