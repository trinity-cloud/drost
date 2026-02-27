import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@drost/core";
import { runProjectRuntime } from "../runtime-loader.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-runtime-loader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("project runtime loader", () => {
  it("falls back to shared runtime loop when runtime entry is absent", async () => {
    const projectRoot = makeTempDir();
    const config: GatewayConfig = {
      workspaceDir: path.join(projectRoot, "workspace")
    };

    const calls: string[] = [];
    const code = await runProjectRuntime({
      projectRoot,
      config,
      pidFilePath: path.join(projectRoot, ".drost", "gateway.pid"),
      uiMode: "plain",
      runDefaultStartLoop: async () => {
        calls.push("default");
        return 13;
      }
    });

    expect(code).toBe(13);
    expect(calls).toEqual(["default"]);
  });

  it("executes project runtime entry when configured", async () => {
    const projectRoot = makeTempDir();
    const runtimeDir = path.join(projectRoot, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "index.ts"),
      [
        "export default {",
        "  async start({ runDefault, config }) {",
        "    const base = await runDefault({ config });",
        "    return base + 1;",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const config: GatewayConfig = {
      workspaceDir: path.join(projectRoot, "workspace"),
      runtime: {
        entry: "./runtime/index.ts"
      }
    };

    const calls: string[] = [];
    const code = await runProjectRuntime({
      projectRoot,
      config,
      pidFilePath: path.join(projectRoot, ".drost", "gateway.pid"),
      uiMode: "plain",
      runDefaultStartLoop: async () => {
        calls.push("default");
        return 20;
      }
    });

    expect(code).toBe(21);
    expect(calls).toEqual(["default"]);
  });

  it("loads TypeScript runtime modules with relative imports", async () => {
    const projectRoot = makeTempDir();
    const runtimeKernelDir = path.join(projectRoot, "runtime", "kernel");
    fs.mkdirSync(runtimeKernelDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "runtime", "index.ts"),
      [
        "import { startProjectRuntime } from \"./kernel/start-loop\";",
        "",
        "export default {",
        "  start: startProjectRuntime",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(runtimeKernelDir, "start-loop.ts"),
      [
        "import { bumpExitCode } from \"./util\";",
        "",
        "export async function startProjectRuntime({ runDefault, config }) {",
        "  const baseCode = await runDefault({ config });",
        "  return bumpExitCode(baseCode);",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(runtimeKernelDir, "util.ts"),
      [
        "export function bumpExitCode(value) {",
        "  return value + 2;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const config: GatewayConfig = {
      workspaceDir: path.join(projectRoot, "workspace"),
      runtime: {
        entry: "./runtime/index.ts"
      }
    };

    const code = await runProjectRuntime({
      projectRoot,
      config,
      pidFilePath: path.join(projectRoot, ".drost", "gateway.pid"),
      uiMode: "plain",
      runDefaultStartLoop: async () => 20
    });

    expect(code).toBe(22);
  });

  it("fails fast when configured runtime entry file is missing", async () => {
    const projectRoot = makeTempDir();
    const config: GatewayConfig = {
      workspaceDir: path.join(projectRoot, "workspace"),
      runtime: {
        entry: "./runtime/missing.ts"
      }
    };

    await expect(
      runProjectRuntime({
        projectRoot,
        config,
        pidFilePath: path.join(projectRoot, ".drost", "gateway.pid"),
        uiMode: "plain",
        runDefaultStartLoop: async () => 0
      })
    ).rejects.toThrow("Runtime entry file not found");
  });
});
