import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStoreError, saveSessionRecord } from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions lock handling", () => {
  it("fails with lock_conflict when active lock does not clear", () => {
    const sessionDirectory = makeTempDir();
    const lockPath = path.join(sessionDirectory, `${encodeURIComponent("alpha")}.lock`);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(lockPath, "external-lock");

    try {
      saveSessionRecord({
        sessionDirectory,
        sessionId: "alpha",
        activeProviderId: "provider-a",
        history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }],
        lock: {
          timeoutMs: 80,
          staleMs: 60_000
        }
      });
      throw new Error("expected lock conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionStoreError);
      expect((error as SessionStoreError).code).toBe("lock_conflict");
    }
  });

  it("reclaims stale locks and proceeds", () => {
    const sessionDirectory = makeTempDir();
    const lockPath = path.join(sessionDirectory, `${encodeURIComponent("beta")}.lock`);
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(lockPath, "stale-lock");
    const staleAt = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const saved = saveSessionRecord({
      sessionDirectory,
      sessionId: "beta",
      activeProviderId: "provider-a",
      history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }],
      lock: {
        timeoutMs: 200,
        staleMs: 50
      }
    });

    expect(saved.sessionId).toBe("beta");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
