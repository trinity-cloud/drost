import fs from "node:fs";
import { toIndexLine, parseIndexLine } from "./codec.js";
import { withLock, writeTextAtomic } from "./locking.js";
import { sessionIndexLockPath, sessionIndexPath } from "./paths.js";
import type { SessionIndexEntry, SessionStoreLockOptions } from "./types.js";
import { ensureDirectory } from "./utils.js";

export function readIndexUnlocked(sessionDirectory: string): SessionIndexEntry[] {
  const filePath = sessionIndexPath(sessionDirectory);
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const bySession = new Map<string, SessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const entry = parseIndexLine(parsed);
      if (!entry) {
        continue;
      }
      bySession.set(entry.sessionId, entry);
    } catch {
      // ignore corrupt lines in index; per-session load will self-heal on save
    }
  }

  return Array.from(bySession.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export function writeIndexUnlocked(sessionDirectory: string, entries: SessionIndexEntry[]): void {
  const deduped = new Map<string, SessionIndexEntry>();
  for (const entry of entries) {
    deduped.set(entry.sessionId, entry);
  }

  const normalized = Array.from(deduped.values()).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const lines = normalized.map((entry) => JSON.stringify(toIndexLine(entry, sessionDirectory)));
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  writeTextAtomic(sessionIndexPath(sessionDirectory), body);
}

export function mutateIndex(
  sessionDirectory: string,
  lockOptions: SessionStoreLockOptions | undefined,
  mutate: (entries: SessionIndexEntry[]) => SessionIndexEntry[]
): SessionIndexEntry[] {
  ensureDirectory(sessionDirectory);
  return withLock(sessionIndexLockPath(sessionDirectory), lockOptions, () => {
    const current = readIndexUnlocked(sessionDirectory);
    const next = mutate(current);
    writeIndexUnlocked(sessionDirectory, next);
    return next;
  });
}

export function resolveIndexEntry(
  sessionDirectory: string,
  sessionId: string,
  entries?: SessionIndexEntry[]
): SessionIndexEntry | undefined {
  const source = entries ?? readIndexUnlocked(sessionDirectory);
  return source.find((entry) => entry.sessionId === sessionId);
}
