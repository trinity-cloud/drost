import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "../providers/types.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-subagents-optional-"));
  tempDirs.push(dir);
  return dir;
}

class SlowEchoAdapter implements ProviderAdapter {
  readonly id = "test-slow-echo-adapter";

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => resolve(), 80);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });

    const text =
      request.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content ?? "";
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: `echo:${text}`
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: `echo:${text}`
      }
    });
  }
}

async function waitForJobCompletion(gateway: ReturnType<typeof createGateway>, jobId: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = gateway.getSubagentJob(jobId);
    const status = job?.status;
    if (status && status !== "queued" && status !== "running") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for subagent job completion");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway subagents and optional modules", () => {
  it("exposes subagent tools and control API routes with timeout/cancel behavior", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      controlApi: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: "admin-token",
        readToken: "read-token",
        allowLoopbackWithoutAuth: false
      },
      subagents: {
        enabled: true,
        maxParallelJobs: 1,
        defaultTimeoutMs: 30,
        lockMode: "none"
      },
      providers: {
        defaultSessionProvider: "echo",
        startupProbe: {
          enabled: false
        },
        profiles: [
          {
            id: "echo",
            adapterId: "test-slow-echo-adapter",
            kind: "openai-compatible",
            model: "test",
            authProfileId: "unused"
          }
        ],
        adapters: [new SlowEchoAdapter()]
      }
    });

    await gateway.start();
    try {
      gateway.ensureSession("local");
      expect(gateway.listLoadedToolNames()).toContain("subagent.start");
      expect(gateway.listLoadedToolNames()).toContain("subagent.cancel");

      const started = await gateway.runTool({
        sessionId: "local",
        toolName: "subagent.start",
        input: {
          input: "slow task",
          timeoutMs: 25
        }
      });
      expect(started.ok).toBe(true);
      const timedOutJobId = (started.output as { job?: { jobId?: string } }).job?.jobId;
      expect(typeof timedOutJobId).toBe("string");

      const timedOutStatus = await waitForJobCompletion(gateway, timedOutJobId as string);
      expect(timedOutStatus).toBe("timed_out");

      const startedToCancel = await gateway.runTool({
        sessionId: "local",
        toolName: "subagent.start",
        input: {
          input: "cancel me",
          timeoutMs: 1000
        }
      });
      expect(startedToCancel.ok).toBe(true);
      const cancelJobId = (startedToCancel.output as { job?: { jobId?: string } }).job?.jobId as string;

      const cancelled = await gateway.runTool({
        sessionId: "local",
        toolName: "subagent.cancel",
        input: {
          jobId: cancelJobId
        }
      });
      expect(cancelled.ok).toBe(true);
      const cancelledStatus = await waitForJobCompletion(gateway, cancelJobId);
      expect(cancelledStatus).toBe("cancelled");

      await gateway.runSessionTurn({
        sessionId: "local",
        input: "still responsive",
        onEvent: () => undefined
      });
      const response =
        gateway
          .getSessionHistory("local")
          .filter((message) => message.role === "assistant")
          .at(-1)?.content ?? "";
      expect(response).toContain("echo:still responsive");

      const controlUrl = gateway.getStatus().controlUrl as string;
      const jobsResponse = await fetch(`${controlUrl}/subagents/jobs`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      expect(jobsResponse.status).toBe(200);
      const jobsPayload = (await jobsResponse.json()) as { ok: boolean; jobs: Array<{ jobId: string }> };
      expect(jobsPayload.ok).toBe(true);
      expect(jobsPayload.jobs.length).toBeGreaterThanOrEqual(2);

      const logsResponse = await fetch(`${controlUrl}/subagents/jobs/${encodeURIComponent(timedOutJobId as string)}/logs`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      expect(logsResponse.status).toBe(200);
      const logsPayload = (await logsResponse.json()) as { ok: boolean; logs: unknown[] };
      expect(logsPayload.ok).toBe(true);
      expect(logsPayload.logs.length).toBeGreaterThan(0);
    } finally {
      await gateway.stop();
    }
  });

  it("runs optional module preflight, heartbeat, and backup routes", async () => {
    const workspaceDir = makeTempDir();
    const heartbeatFile = path.join(workspaceDir, ".drost", "automation", "heartbeat.test.json");
    const gateway = createGateway({
      workspaceDir,
      controlApi: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        token: "admin-token",
        readToken: "read-token",
        allowLoopbackWithoutAuth: false
      },
      optionalModules: {
        memory: {
          enabled: true,
          provider: "filesystem",
          directory: "./.drost/memory"
        },
        graph: {
          enabled: true,
          provider: "filesystem",
          directory: "./.drost/graph"
        },
        scheduler: {
          enabled: true,
          heartbeatIntervalMs: 20,
          heartbeatFile
        },
        backup: {
          enabled: true,
          directory: "./.drost/backups"
        }
      }
    });

    await gateway.start();
    try {
      const status = gateway.getStatus();
      expect(status.optionalModules?.find((entry) => entry.module === "memory")?.healthy).toBe(true);
      expect(status.optionalModules?.find((entry) => entry.module === "graph")?.healthy).toBe(true);
      expect(status.optionalModules?.find((entry) => entry.module === "scheduler")?.healthy).toBe(true);
      expect(status.optionalModules?.find((entry) => entry.module === "backup")?.healthy).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fs.existsSync(heartbeatFile)).toBe(true);

      const controlUrl = status.controlUrl as string;
      const optionalStatus = await fetch(`${controlUrl}/optional/status`, {
        headers: {
          authorization: "Bearer read-token"
        }
      });
      expect(optionalStatus.status).toBe(200);
      const optionalPayload = (await optionalStatus.json()) as { ok: boolean; modules: unknown[] };
      expect(optionalPayload.ok).toBe(true);
      expect(optionalPayload.modules.length).toBeGreaterThanOrEqual(4);

      const backupCreate = await fetch(`${controlUrl}/backup/create`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      expect(backupCreate.status).toBe(200);
      const backupPayload = (await backupCreate.json()) as { ok: boolean; backupPath?: string };
      expect(backupPayload.ok).toBe(true);
      expect(typeof backupPayload.backupPath).toBe("string");
      expect(fs.existsSync(backupPayload.backupPath as string)).toBe(true);

      const restore = await fetch(`${controlUrl}/backup/restore`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          backupPath: backupPayload.backupPath
        })
      });
      expect(restore.status).toBe(200);
      const restorePayload = (await restore.json()) as { ok: boolean };
      expect(restorePayload.ok).toBe(true);
    } finally {
      await gateway.stop();
    }
  });

  it("degrades gracefully when optional memory postgres config is invalid", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway({
      workspaceDir,
      optionalModules: {
        memory: {
          enabled: true,
          provider: "postgres"
        }
      }
    });

    const status = await gateway.start();
    try {
      expect(status.state).toBe("degraded");
      expect(status.optionalModules?.find((entry) => entry.module === "memory")?.healthy).toBe(false);
    } finally {
      await gateway.stop();
    }
  });
});
