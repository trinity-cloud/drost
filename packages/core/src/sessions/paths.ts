import path from "node:path";
import {
  SESSION_ARCHIVE_DIR,
  SESSION_CORRUPT_DIR,
  SESSION_FULL_SUFFIX,
  SESSION_INDEX_FILE,
  SESSION_INDEX_LOCK_FILE,
  SESSION_TRANSCRIPT_SUFFIX
} from "./constants.js";
import { sanitizeSessionId } from "./utils.js";

export function sessionIndexPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_INDEX_FILE);
}

export function sessionIndexLockPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_INDEX_LOCK_FILE);
}

export function sessionCorruptDirectoryPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_CORRUPT_DIR);
}

export function sessionArchiveDirectoryPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, SESSION_ARCHIVE_DIR);
}

export function sessionTranscriptPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}${SESSION_TRANSCRIPT_SUFFIX}`);
}

export function sessionFullPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}${SESSION_FULL_SUFFIX}`);
}

export function sessionLockPath(sessionDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory, `${sanitizeSessionId(sessionId)}.lock`);
}
