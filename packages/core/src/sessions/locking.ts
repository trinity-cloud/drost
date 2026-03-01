import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOCK_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS } from "./constants.js";
import { SessionStoreError, type SessionStoreLockOptions } from "./types.js";
import { ensureDirectory, sleepMs } from "./utils.js";

export function withLock<T>(
  lockFilePath: string,
  options: SessionStoreLockOptions | undefined,
  run: () => T
): T {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const started = Date.now();
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockFilePath, "wx");
      fs.writeFileSync(fd, `${process.pid}:${Date.now()}`);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw new SessionStoreError("io_error", err.message || String(error));
      }

      try {
        const stat = fs.statSync(lockFilePath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockFilePath, { force: true });
          continue;
        }
      } catch {
        // best effort stale lock cleanup; continue acquire loop
      }

      if (Date.now() - started >= timeoutMs) {
        throw new SessionStoreError("lock_conflict", `Session lock timeout: ${path.basename(lockFilePath)}`);
      }
      sleepMs(15);
    }
  }

  try {
    return run();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(lockFilePath, { force: true });
    } catch {
      // best effort
    }
  }
}

export function writeTextAtomic(filePath: string, content: string): void {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort
    }
  }
}

export function appendText(filePath: string, content: string): void {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, content, "utf8");
}
