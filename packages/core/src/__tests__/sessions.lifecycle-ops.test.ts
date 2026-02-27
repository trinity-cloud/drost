import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionStoreError,
  archiveSessionRecord,
  deleteSessionRecord,
  exportSessionRecord,
  importSessionRecord,
  listSessionIds,
  loadSessionRecord,
  renameSessionRecord,
  saveSessionRecord
} from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-lifecycle-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions lifecycle ops", () => {
  it("renames and deletes session records safely", () => {
    const sessionDirectory = makeTempDir();
    saveSessionRecord({
      sessionDirectory,
      sessionId: "alpha",
      activeProviderId: "provider-a",
      history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }]
    });

    const renamed = renameSessionRecord({
      sessionDirectory,
      fromSessionId: "alpha",
      toSessionId: "beta"
    });
    expect(renamed.sessionId).toBe("beta");
    expect(loadSessionRecord(sessionDirectory, "alpha")).toBeNull();
    expect(loadSessionRecord(sessionDirectory, "beta")?.history.length).toBe(1);
    expect(listSessionIds(sessionDirectory)).toEqual(["beta"]);

    expect(deleteSessionRecord({ sessionDirectory, sessionId: "beta" })).toBe(true);
    expect(deleteSessionRecord({ sessionDirectory, sessionId: "beta" })).toBe(false);
    expect(listSessionIds(sessionDirectory)).toEqual([]);
  });

  it("exports and imports sessions with overwrite guards", () => {
    const sessionDirectory = makeTempDir();
    saveSessionRecord({
      sessionDirectory,
      sessionId: "source",
      activeProviderId: "provider-a",
      history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }],
      metadata: {
        title: "Source"
      }
    });

    const exported = exportSessionRecord({
      sessionDirectory,
      sessionId: "source"
    });
    expect(exported).not.toBeNull();
    if (!exported) {
      return;
    }

    const imported = importSessionRecord({
      sessionDirectory,
      record: {
        ...exported,
        sessionId: "target"
      }
    });
    expect(imported.sessionId).toBe("target");
    expect(loadSessionRecord(sessionDirectory, "target")?.metadata.title).toBe("Source");

    try {
      importSessionRecord({
        sessionDirectory,
        record: imported,
        overwrite: false
      });
      throw new Error("expected already_exists error");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionStoreError);
      expect((error as SessionStoreError).code).toBe("already_exists");
    }
  });

  it("archives sessions into archive storage", () => {
    const sessionDirectory = makeTempDir();
    saveSessionRecord({
      sessionDirectory,
      sessionId: "archive-me",
      activeProviderId: "provider-a",
      history: [{ role: "user", content: "hello", createdAt: "2026-02-26T00:00:00.000Z" }]
    });

    const archived = archiveSessionRecord({
      sessionDirectory,
      sessionId: "archive-me"
    });
    expect(archived).not.toBeNull();
    if (archived) {
      expect(fs.existsSync(archived.archivedPath)).toBe(true);
    }
    expect(loadSessionRecord(sessionDirectory, "archive-me")).toBeNull();
    expect(listSessionIds(sessionDirectory)).toEqual([]);
  });
});
