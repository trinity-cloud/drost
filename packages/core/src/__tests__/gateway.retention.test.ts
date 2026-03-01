import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveSessionRecord } from "../sessions.js";
import { createGateway } from "../index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-retention-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway retention status and prune", () => {
  it("reports retention status and supports dry-run/manual prune", async () => {
    const workspaceDir = makeTempDir();
    const sessionDirectory = path.join(workspaceDir, ".drost", "sessions");

    saveSessionRecord({
      sessionDirectory,
      sessionId: "s1",
      activeProviderId: "p",
      history: [{ role: "user", content: "one", createdAt: "2026-02-26T00:00:00.000Z" }],
      metadata: {
        createdAt: "2026-02-26T00:00:00.000Z",
        lastActivityAt: "2026-02-26T00:00:01.000Z"
      }
    });
    saveSessionRecord({
      sessionDirectory,
      sessionId: "s2",
      activeProviderId: "p",
      history: [{ role: "user", content: "two", createdAt: "2026-02-27T00:00:00.000Z" }],
      metadata: {
        createdAt: "2026-02-27T00:00:00.000Z",
        lastActivityAt: "2026-02-27T00:00:01.000Z"
      }
    });
    saveSessionRecord({
      sessionDirectory,
      sessionId: "s3",
      activeProviderId: "p",
      history: [{ role: "user", content: "three", createdAt: "2026-02-28T00:00:00.000Z" }],
      metadata: {
        createdAt: "2026-02-28T00:00:00.000Z",
        lastActivityAt: "2026-02-28T00:00:01.000Z"
      }
    });

    const gateway = createGateway({
      workspaceDir,
      sessionStore: {
        enabled: true,
        directory: sessionDirectory,
        retention: {
          enabled: true,
          maxSessions: 3,
          archiveFirst: false
        }
      }
    });

    await gateway.start();
    try {
      const statusBefore = gateway.getSessionRetentionStatus();
      expect(statusBefore.enabled).toBe(true);
      expect(statusBefore.totalSessions).toBe(3);
      expect(statusBefore.totalBytes).toBeGreaterThan(0);

      const dryRun = gateway.pruneSessions({
        dryRun: true,
        policyOverride: {
          enabled: true,
          maxSessions: 1,
          archiveFirst: false
        }
      });
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.deleted.length).toBe(2);
      expect(gateway.listPersistedSessionIds().length).toBe(3);

      const applied = gateway.pruneSessions({
        policyOverride: {
          enabled: true,
          maxSessions: 1,
          archiveFirst: false
        }
      });
      expect(applied.dryRun).toBe(false);
      expect(applied.deleted.length).toBe(2);
      expect(gateway.listPersistedSessionIds().length).toBe(1);

      const statusAfter = gateway.getSessionRetentionStatus();
      expect(statusAfter.totalSessions).toBe(1);
    } finally {
      await gateway.stop();
    }
  });
});
