import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { GatewayConfig } from "../config.js";
import type { NormalizedStreamEvent } from "../events.js";
import { createGateway, defineTool } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-tool-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway tool runtime", () => {
  it("runs built-in file and agent tools with mutable-root enforcement", async () => {
    const workspaceDir = makeTempDir();
    const outsidePath = path.join(path.dirname(workspaceDir), "outside.txt");
    fs.writeFileSync(outsidePath, "outside-ok", "utf8");
    const gateway = createGateway({
      workspaceDir
    });

    await gateway.start();

    const write = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "write",
        path: "notes/todo.txt",
        content: "ship-it"
      }
    });
    expect(write.ok).toBe(true);

    const read = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "read",
        path: "notes/todo.txt"
      }
    });
    expect(read.ok).toBe(true);
    expect((read.output as { content?: string }).content).toBe("ship-it");

    const edit = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "edit",
        path: "notes/todo.txt",
        search: "ship",
        replace: "build"
      }
    });
    expect(edit.ok).toBe(true);
    expect((edit.output as { replacedCount?: number }).replacedCount).toBe(1);

    const list = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "list",
        path: "notes"
      }
    });
    expect(list.ok).toBe(true);
    expect(
      (list.output as { entries?: Array<{ path: string }> }).entries?.some((entry) => entry.path.endsWith("todo.txt"))
    ).toBe(true);

    const escaped = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "read",
        path: "../outside.txt"
      }
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.error?.message).toContain("outside mutable roots");

    const status = await gateway.runTool({
      sessionId: "local",
      toolName: "agent",
      input: {
        action: "status"
      }
    });
    expect(status.ok).toBe(true);
    expect((status.output as { loadedTools?: string[] }).loadedTools).toContain("file");

    const missing = await gateway.runTool({
      sessionId: "local",
      toolName: "does-not-exist",
      input: {}
    });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("tool_not_found");

    await gateway.stop();
  });

  it("blocks file mutations outside configured mutableRoots", async () => {
    const workspaceDir = makeTempDir();
    fs.mkdirSync(path.join(workspaceDir, "allowed"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "blocked"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "blocked", "notes.txt"), "seed", "utf8");

    const gateway = createGateway({
      workspaceDir,
      evolution: {
        enabled: true,
        mutableRoots: ["./allowed"]
      }
    });
    await gateway.start();

    const allowedWrite = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "write",
        path: "allowed/ok.txt",
        content: "ok"
      }
    });
    expect(allowedWrite.ok).toBe(true);

    const blockedWrite = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "write",
        path: "blocked/nope.txt",
        content: "nope"
      }
    });
    expect(blockedWrite.ok).toBe(false);
    expect(blockedWrite.error?.message).toContain("outside mutable roots");

    const blockedEdit = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "edit",
        path: "blocked/notes.txt",
        search: "seed",
        replace: "changed"
      }
    });
    expect(blockedEdit.ok).toBe(false);
    expect(blockedEdit.error?.message).toContain("outside mutable roots");

    const readBlocked = await gateway.runTool({
      sessionId: "local",
      toolName: "file",
      input: {
        action: "read",
        path: "blocked/notes.txt"
      }
    });
    expect(readBlocked.ok).toBe(false);
    expect(readBlocked.error?.message).toContain("outside mutable roots");

    await gateway.stop();
  });

  it("emits tool lifecycle events and runs shell/web tools", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir
    });
    await gateway.start();

    const server = http.createServer((_, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("hello-from-web-tool");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address !== "object") {
      throw new Error("Failed to bind test server");
    }
    const url = `http://127.0.0.1:${address.port}/hello`;
    const events: NormalizedStreamEvent[] = [];

    const shellResult = await gateway.runTool({
      sessionId: "local",
      toolName: "shell",
      input: {
        command: "printf hello-shell"
      },
      onEvent: (event) => events.push(event)
    });
    expect(shellResult.ok).toBe(true);
    expect((shellResult.output as { stdout?: string }).stdout).toContain("hello-shell");

    const webResult = await gateway.runTool({
      sessionId: "local",
      toolName: "web",
      input: {
        action: "fetch",
        url
      },
      onEvent: (event) => events.push(event)
    });
    expect(webResult.ok).toBe(true);
    expect((webResult.output as { body?: string }).body).toContain("hello-from-web-tool");

    const started = events.filter((event) => event.type === "tool.call.started");
    const completed = events.filter((event) => event.type === "tool.call.completed");
    expect(started.length).toBe(2);
    expect(completed.length).toBe(2);
    expect(started[0]?.payload.toolName).toBe("shell");
    expect(completed[1]?.payload.toolName).toBe("web");

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.stop();
  });

  it("enforces shell allow/deny command prefix policy", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      shell: {
        allowCommandPrefixes: ["printf", "echo"],
        denyCommandPrefixes: ["rm -rf", "curl"]
      }
    });
    await gateway.start();

    const allowed = await gateway.runTool({
      sessionId: "local",
      toolName: "shell",
      input: {
        command: "printf hi"
      }
    });
    expect(allowed.ok).toBe(true);

    const denied = await gateway.runTool({
      sessionId: "local",
      toolName: "shell",
      input: {
        command: "curl https://example.com"
      }
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("denied");

    await gateway.stop();
  });

  it("validates tool input for zod-backed tool schemas", async () => {
    const workspaceDir = makeTempDir();
    const sumTool = defineTool<{ a: number; b: number }, { sum: number }>({
      name: "sum_numbers",
      description: "Add two numbers",
      parameters: z.object({
        a: z.number(),
        b: z.number()
      }),
      execute: ({ a, b }) => ({ sum: a + b })
    });

    const config: GatewayConfig = {
      workspaceDir,
      builtInTools: [sumTool]
    };
    const gateway = createGateway(config);
    await gateway.start();

    const invalid = await gateway.runTool({
      sessionId: "local",
      toolName: "sum_numbers",
      input: {
        a: "1",
        b: 2
      }
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("validation_error");
    expect(invalid.error?.issues?.length).toBeGreaterThan(0);

    const valid = await gateway.runTool({
      sessionId: "local",
      toolName: "sum_numbers",
      input: {
        a: 1,
        b: 2
      }
    });
    expect(valid.ok).toBe(true);
    expect((valid.output as { sum?: number }).sum).toBe(3);

    await gateway.stop();
  });
});
