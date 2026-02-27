import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultBuiltInTools, buildToolRegistry } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool registry", () => {
  it("skips invalid custom tools instead of crashing startup", async () => {
    const dir = makeTempDir();
    const toolsDir = path.join(dir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    fs.writeFileSync(path.join(toolsDir, "broken.mjs"), "export default {};\n");

    const registry = await buildToolRegistry({
      builtInTools: createDefaultBuiltInTools(),
      customToolsDirectory: toolsDir
    });

    expect(registry.diagnostics.skipped.length).toBe(1);
    expect(registry.diagnostics.skipped[0]?.reason).toBe("invalid_shape");
    expect(registry.tools.has("file")).toBe(true);
  });

  it("blocks custom tool names that collide with built-in tools", async () => {
    const dir = makeTempDir();
    const toolsDir = path.join(dir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    fs.writeFileSync(
      path.join(toolsDir, "collision.mjs"),
      [
        "export default {",
        "  name: 'file',",
        "  execute: async () => ({ ok: true })",
        "};"
      ].join("\n")
    );

    const registry = await buildToolRegistry({
      builtInTools: createDefaultBuiltInTools(),
      customToolsDirectory: toolsDir
    });

    expect(registry.diagnostics.skipped.length).toBe(1);
    expect(registry.diagnostics.skipped[0]?.reason).toBe("name_collision");
    expect(registry.diagnostics.skipped[0]?.toolName).toBe("file");
  });

  it("loads TypeScript custom tools that import sibling modules", async () => {
    const dir = makeTempDir();
    const toolsDir = path.join(dir, "tools");
    fs.mkdirSync(path.join(toolsDir, "lib"), { recursive: true });

    fs.writeFileSync(
      path.join(toolsDir, "lib", "helper.ts"),
      [
        "export function buildResult(input) {",
        "  return { echoed: input };",
        "}",
        ""
      ].join("\n")
    );

    fs.writeFileSync(
      path.join(toolsDir, "ts-relative.ts"),
      [
        "import { buildResult } from './lib/helper';",
        "",
        "export default {",
        "  name: 'ts_relative',",
        "  execute: async (input) => buildResult(input)",
        "};",
        ""
      ].join("\n")
    );

    const registry = await buildToolRegistry({
      builtInTools: createDefaultBuiltInTools(),
      customToolsDirectory: toolsDir
    });

    const loaded = registry.tools.get("ts_relative");
    expect(loaded).toBeDefined();
    const result = await loaded?.execute({ hello: "world" }, {
      workspaceDir: dir,
      mutableRoots: [dir],
      sessionId: "local",
      providerId: "test"
    });
    expect(result).toEqual({ echoed: { hello: "world" } });
  });
});
