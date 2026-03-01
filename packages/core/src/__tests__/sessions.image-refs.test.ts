import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionRecord, saveSessionRecord } from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-image-refs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions image refs", () => {
  it("persists image refs across save/load and transcript writes", () => {
    const sessionDirectory = makeTempDir();
    const createdAt = "2026-03-01T10:00:00.000Z";
    saveSessionRecord({
      sessionDirectory,
      sessionId: "img-session",
      activeProviderId: "provider-a",
      history: [
        {
          role: "user",
          content: "What is this image?",
          createdAt,
          imageRefs: [
            {
              id: "img_1",
              mimeType: "image/png",
              sha256: "a".repeat(64),
              bytes: 128,
              path: ".drost/media/img-session/a.png"
            }
          ]
        },
        {
          role: "assistant",
          content: "It looks like a logo.",
          createdAt
        }
      ]
    });

    const loaded = loadSessionRecord(sessionDirectory, "img-session");
    expect(loaded).not.toBeNull();
    expect(loaded?.history[0]?.imageRefs?.[0]?.mimeType).toBe("image/png");
    expect(loaded?.history[0]?.imageRefs?.[0]?.path).toBe(".drost/media/img-session/a.png");

    const files = fs.readdirSync(sessionDirectory);
    const fullFile = files.find((entry) => entry.endsWith(".full.jsonl"));
    const transcriptFile = files.find(
      (entry) => entry.endsWith(".jsonl") && !entry.endsWith(".full.jsonl") && !entry.includes("index")
    );
    expect(fullFile).toBeDefined();
    expect(transcriptFile).toBeDefined();
    const fullText = fs.readFileSync(path.join(sessionDirectory, String(fullFile)), "utf8");
    const transcriptText = fs.readFileSync(path.join(sessionDirectory, String(transcriptFile)), "utf8");
    expect(fullText).toContain("\"imageRefs\":");
    expect(transcriptText).toContain("\"imageRefs\":");
  });
});
