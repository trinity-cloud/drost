import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, RESTART_EXIT_CODE } from "../index.js";

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-gateway-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway restart contract", () => {
  it("requests restart with exit code 42", async () => {
    const workspaceDir = makeTempDir();
    const gateway = createGateway(
      {
        workspaceDir
      },
      {
        exit: (code) => {
          throw new ExitSignal(code);
        }
      }
    );

    await gateway.start();

    let caught: ExitSignal | null = null;
    try {
      await gateway.requestRestart();
    } catch (error) {
      if (error instanceof ExitSignal) {
        caught = error;
      } else {
        throw error;
      }
    }

    expect(caught?.code).toBe(RESTART_EXIT_CODE);
    expect(gateway.getStatus().state).toBe("stopped");
  });
});
