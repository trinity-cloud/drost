import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionIds, loadSessionRecordWithDiagnostics } from "../sessions.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-sessions-corrupt-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions corruption recovery", () => {
  it("quarantines corrupt json and emits diagnostics", () => {
    const sessionDirectory = makeTempDir();
    const sessionPath = path.join(sessionDirectory, `${encodeURIComponent("alpha")}.full.jsonl`);
    fs.writeFileSync(sessionPath, "{not-json");

    const result = loadSessionRecordWithDiagnostics(sessionDirectory, "alpha");
    expect(result.record).toBeNull();
    expect(result.diagnostics?.[0]?.code).toBe("corrupt_json");
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(result.diagnostics?.[0]?.quarantinedPath).toBeDefined();
    if (result.diagnostics?.[0]?.quarantinedPath) {
      expect(fs.existsSync(result.diagnostics[0].quarantinedPath)).toBe(true);
    }
    expect(listSessionIds(sessionDirectory)).toEqual([]);
  });

  it("quarantines invalid-shape payloads", () => {
    const sessionDirectory = makeTempDir();
    const sessionPath = path.join(sessionDirectory, `${encodeURIComponent("beta")}.full.jsonl`);
    fs.writeFileSync(sessionPath, `${JSON.stringify({ foo: "bar" })}\n`);

    const result = loadSessionRecordWithDiagnostics(sessionDirectory, "beta");
    expect(result.record).toBeNull();
    expect(result.diagnostics?.[0]?.code).toBe("invalid_shape");
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(result.diagnostics?.[0]?.quarantinedPath).toBeDefined();
  });
});
