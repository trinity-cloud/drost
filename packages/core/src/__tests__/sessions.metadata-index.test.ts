import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionIndex, loadSessionRecord, saveSessionRecord } from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-index-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions metadata index", () => {
  it("stores and surfaces metadata/title/origin in the session index", () => {
    const sessionDirectory = makeTempDir();

    saveSessionRecord({
      sessionDirectory,
      sessionId: "alpha",
      activeProviderId: "provider-a",
      history: [
        {
          role: "user",
          content: "alpha question",
          createdAt: "2026-02-26T00:00:10.000Z"
        }
      ],
      metadata: {
        createdAt: "2026-02-26T00:00:00.000Z",
        lastActivityAt: "2026-02-26T00:00:10.000Z",
        title: "Alpha session",
        origin: {
          channel: "telegram",
          workspaceId: "wk-1",
          chatId: "chat-10"
        }
      }
    });

    saveSessionRecord({
      sessionDirectory,
      sessionId: "beta",
      activeProviderId: "provider-b",
      history: [
        {
          role: "user",
          content: "beta question",
          createdAt: "2026-02-26T00:01:00.000Z"
        },
        {
          role: "assistant",
          content: "beta answer",
          createdAt: "2026-02-26T00:01:03.000Z"
        }
      ],
      metadata: {
        createdAt: "2026-02-26T00:00:30.000Z",
        lastActivityAt: "2026-02-26T00:01:03.000Z",
        title: "Beta session"
      }
    });

    const index = listSessionIndex(sessionDirectory);
    expect(index.map((entry) => entry.sessionId)).toEqual(["alpha", "beta"]);

    const alpha = index.find((entry) => entry.sessionId === "alpha");
    expect(alpha?.historyCount).toBe(1);
    expect(alpha?.title).toBe("Alpha session");
    expect(alpha?.origin?.channel).toBe("telegram");
    expect(alpha?.createdAt).toBe("2026-02-26T00:00:00.000Z");
    expect(alpha?.lastActivityAt).toBe("2026-02-26T00:00:10.000Z");

    const loaded = loadSessionRecord(sessionDirectory, "alpha");
    expect(loaded?.metadata.title).toBe("Alpha session");
    expect(loaded?.metadata.origin?.chatId).toBe("chat-10");
  });
});
