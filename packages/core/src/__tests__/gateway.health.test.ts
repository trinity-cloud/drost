import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-health-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway health endpoint", () => {
  it("serves runtime status JSON on configured health path", async () => {
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
    const status = gateway.getStatus();
    expect(status.healthUrl).toBeDefined();

    const response = await fetch(status.healthUrl as string);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      state: string;
      uptimeSec: number;
      healthUrl?: string;
    };
    expect(payload.state).toBe("running");
    expect(typeof payload.uptimeSec).toBe("number");
    expect(payload.healthUrl).toBe(status.healthUrl);

    const notFound = await fetch((status.healthUrl as string).replace("/healthz", "/missing"));
    expect(notFound.status).toBe(404);

    await gateway.stop();
  });
});
