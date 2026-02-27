import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-code-tools-"));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  });
}

function makePatchFor(targetPath: string, from: string, to: string): string {
  return [
    `diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    "@@ -1 +1 @@",
    `-export const marker = "${from}";`,
    `+export const marker = "${to}";`,
    ""
  ].join("\n");
}

function makePatch(from: string, to: string): string {
  return makePatchFor("agent/index.ts", from, to);
}

function setupRepo(): { rootDir: string; workspaceDir: string; agentDir: string; runtimeDir: string } {
  const rootDir = makeTempDir();
  const workspaceDir = path.join(rootDir, "workspace");
  const agentDir = path.join(rootDir, "agent");
  const runtimeDir = path.join(rootDir, "runtime", "kernel");

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "index.ts"), 'export const marker = "agent-v1";\n', "utf8");
  fs.writeFileSync(path.join(runtimeDir, "policy.ts"), 'export const marker = "runtime-v1";\n', "utf8");
  fs.writeFileSync(path.join(workspaceDir, "readme.md"), "workspace seed\n", "utf8");

  runGit(rootDir, ["init"]);
  runGit(rootDir, ["config", "user.email", "test@example.com"]);
  runGit(rootDir, ["config", "user.name", "Drost Test"]);
  runGit(rootDir, ["add", "-A"]);
  runGit(rootDir, ["commit", "-m", "seed"]);

  return { rootDir, workspaceDir, agentDir, runtimeDir: path.join(rootDir, "runtime") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("code evolution tools", () => {
  it("runs code.search/read_context/status/diff/patch over mutable roots", async () => {
    const repo = setupRepo();
    const gateway = createGateway({
      workspaceDir: repo.workspaceDir,
      evolution: {
        enabled: true,
        mutableRoots: [repo.workspaceDir, repo.agentDir]
      }
    });
    await gateway.start();

    const searchBefore = await gateway.runTool({
      sessionId: "local",
      toolName: "code.search",
      input: {
        query: "agent-v1",
        literal: true
      }
    });
    expect(searchBefore.ok).toBe(true);
    const beforeMatches = (searchBefore.output as { matches?: Array<{ path: string }> }).matches ?? [];
    expect(beforeMatches.some((entry) => entry.path === "../agent/index.ts")).toBe(true);

    const read = await gateway.runTool({
      sessionId: "local",
      toolName: "code.read_context",
      input: {
        path: "../agent/index.ts",
        line: 1,
        before: 0,
        after: 0
      }
    });
    expect(read.ok).toBe(true);
    expect((read.output as { lines?: Array<{ text: string }> }).lines?.[0]?.text).toContain("agent-v1");

    const dryRunPatch = await gateway.runTool({
      sessionId: "local",
      toolName: "code.patch",
      input: {
        patch: makePatch("agent-v1", "agent-v2"),
        dryRun: true
      }
    });
    expect(dryRunPatch.ok).toBe(true);

    const applyPatch = await gateway.runTool({
      sessionId: "local",
      toolName: "code.patch",
      input: {
        patch: makePatch("agent-v1", "agent-v2")
      }
    });
    expect(applyPatch.ok).toBe(true);

    const status = await gateway.runTool({
      sessionId: "local",
      toolName: "code.status",
      input: {
        scope: "mutable_roots"
      }
    });
    expect(status.ok).toBe(true);
    const files = (status.output as { files?: Array<{ path: string }> }).files ?? [];
    expect(files.some((entry) => entry.path === "../agent/index.ts")).toBe(true);

    const diff = await gateway.runTool({
      sessionId: "local",
      toolName: "code.diff",
      input: {
        paths: ["../agent/index.ts"]
      }
    });
    expect(diff.ok).toBe(true);
    expect((diff.output as { diff?: string }).diff).toContain("agent-v2");

    const searchAfter = await gateway.runTool({
      sessionId: "local",
      toolName: "code.search",
      input: {
        query: "agent-v2",
        literal: true
      }
    });
    expect(searchAfter.ok).toBe(true);
    const afterMatches = (searchAfter.output as { matches?: Array<{ path: string }> }).matches ?? [];
    expect(afterMatches.some((entry) => entry.path === "../agent/index.ts")).toBe(true);

    await gateway.stop();
  });

  it("rejects stale expectedBase for code.patch", async () => {
    const repo = setupRepo();
    const originalHead = runGit(repo.rootDir, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(repo.workspaceDir, "changelog.md"), "new commit\n", "utf8");
    runGit(repo.rootDir, ["add", "-A"]);
    runGit(repo.rootDir, ["commit", "-m", "advance head"]);

    const gateway = createGateway({
      workspaceDir: repo.workspaceDir,
      evolution: {
        enabled: true,
        mutableRoots: [repo.workspaceDir, repo.agentDir]
      }
    });
    await gateway.start();

    const stale = await gateway.runTool({
      sessionId: "local",
      toolName: "code.patch",
      input: {
        patch: makePatch("agent-v1", "agent-v2"),
        expectedBase: {
          kind: "git_head",
          value: originalHead
        }
      }
    });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("execution_error");
    expect(stale.error?.message).toContain("stale_revision");

    await gateway.stop();
  });

  it("allows code.patch when patch targets path outside mutable roots", async () => {
    const repo = setupRepo();
    const gateway = createGateway({
      workspaceDir: repo.workspaceDir,
      evolution: {
        enabled: true,
        mutableRoots: [repo.workspaceDir]
      }
    });
    await gateway.start();

    const patch = await gateway.runTool({
      sessionId: "local",
      toolName: "code.patch",
      input: {
        patch: makePatch("agent-v1", "agent-v2")
      }
    });
    expect(patch.ok).toBe(true);

    const read = await gateway.runTool({
      sessionId: "local",
      toolName: "code.read_context",
      input: {
        path: "../agent/index.ts",
        line: 1,
        before: 0,
        after: 0
      }
    });
    expect(read.ok).toBe(true);
    expect((read.output as { lines?: Array<{ text: string }> }).lines?.[0]?.text).toContain("agent-v2");

    await gateway.stop();
  });

  it("allows runtime file mutation when runtime root is in mutableRoots", async () => {
    const repo = setupRepo();
    const gateway = createGateway({
      workspaceDir: repo.workspaceDir,
      evolution: {
        enabled: true,
        mutableRoots: [repo.workspaceDir, repo.runtimeDir]
      }
    });
    await gateway.start();

    const applyPatch = await gateway.runTool({
      sessionId: "local",
      toolName: "code.patch",
      input: {
        patch: makePatchFor("runtime/kernel/policy.ts", "runtime-v1", "runtime-v2")
      }
    });
    expect(applyPatch.ok).toBe(true);

    const read = await gateway.runTool({
      sessionId: "local",
      toolName: "code.read_context",
      input: {
        path: "../runtime/kernel/policy.ts",
        line: 1,
        before: 0,
        after: 0
      }
    });
    expect(read.ok).toBe(true);
    expect((read.output as { lines?: Array<{ text: string }> }).lines?.[0]?.text).toContain("runtime-v2");

    await gateway.stop();
  });
});
