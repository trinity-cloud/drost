import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, migrateProjectRuntime } from "../init.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-cli-init-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("drost init scaffold", () => {
  it("creates mutable agent/runtime source and evolution defaults", () => {
    const sandboxRoot = makeTempDir();
    const previousCwd = process.cwd();
    process.chdir(sandboxRoot);
    try {
      const result = initProject("agent-a");
      expect(result.created).toBe(true);

      const projectPath = path.join(sandboxRoot, "agent-a");
      expect(fs.existsSync(path.join(projectPath, "agent", "index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, "agent", "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, "runtime", "index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, "runtime", "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, "runtime", "kernel", "start-loop.ts"))).toBe(true);
      expect(fs.existsSync(path.join(projectPath, "runtime", "kernel", "policy.ts"))).toBe(true);

      const configText = fs.readFileSync(path.join(projectPath, "drost.config.ts"), "utf8");
      expect(configText).toContain("runtime: {");
      expect(configText).toContain('entry: "./runtime/index.ts"');
      expect(configText).toContain("agent: {");
      expect(configText).toContain('entry: "./agent/index.ts"');
      expect(configText).toContain("evolution: {");
      expect(configText).toContain("mutableRoots");
      expect(configText).toContain('"./runtime"');

      const runtimeEntryText = fs.readFileSync(path.join(projectPath, "runtime", "index.ts"), "utf8");
      expect(runtimeEntryText).toContain("startProjectRuntime");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("migrates existing project by scaffolding missing runtime kernel files", () => {
    const sandboxRoot = makeTempDir();
    const projectPath = path.join(sandboxRoot, "legacy-agent");
    fs.mkdirSync(path.join(projectPath, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, "drost.config.ts"), "export default { workspaceDir: \"./workspace\" };\n", "utf8");

    const result = migrateProjectRuntime(projectPath);
    expect(result.createdFiles.length).toBeGreaterThan(0);
    expect(result.createdFiles).toContain("runtime/index.ts");
    expect(result.createdFiles).toContain("runtime/kernel/start-loop.ts");
    expect(result.createdFiles).toContain("runtime/kernel/policy.ts");

    expect(fs.existsSync(path.join(projectPath, "runtime", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, "runtime", "kernel", "start-loop.ts"))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, "runtime", "kernel", "policy.ts"))).toBe(true);
  });
});
