import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCliConfig } from "../config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-cli-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadCliConfig", () => {
  it("treats current project root as workspace when config file is absent", async () => {
    const projectRoot = makeTempDir();
    const loaded = await loadCliConfig(projectRoot);

    expect(loaded.configPath).toBeNull();
    expect(loaded.gatewayConfig.workspaceDir).toBe(projectRoot);
    expect(loaded.gatewayConfig.evolution?.mutableRoots).toContain(projectRoot);
  });
});

