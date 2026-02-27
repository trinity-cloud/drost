import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionRecord, saveSessionRecord } from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-atomic-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions atomic write", () => {
  it("writes v2 session payloads without leaving temp files and increments revision", () => {
    const sessionDirectory = makeTempDir();

    const first = saveSessionRecord({
      sessionDirectory,
      sessionId: "alpha",
      activeProviderId: "provider-a",
      history: [
        {
          role: "user",
          content: "hello",
          createdAt: "2026-02-26T00:00:00.000Z"
        }
      ]
    });
    const second = saveSessionRecord({
      sessionDirectory,
      sessionId: "alpha",
      activeProviderId: "provider-a",
      history: [
        ...first.history,
        {
          role: "assistant",
          content: "hi",
          createdAt: "2026-02-26T00:00:01.000Z"
        }
      ]
    });

    const filePath = path.join(sessionDirectory, `${encodeURIComponent("alpha")}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(fs.readFileSync(filePath, "utf8")).toContain('"version": 2');

    const leftovers = fs.readdirSync(sessionDirectory).filter((entry) => entry.includes(".tmp-"));
    expect(leftovers).toEqual([]);

    const loaded = loadSessionRecord(sessionDirectory, "alpha");
    expect(loaded?.history.length).toBe(2);
    expect(loaded?.revision).toBe(2);
  });
});
