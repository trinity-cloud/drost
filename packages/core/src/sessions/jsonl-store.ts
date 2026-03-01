import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../types.js";
import { parseSessionEventLine, parseSessionMessageLine } from "./codec.js";
import { sessionCorruptDirectoryPath } from "./paths.js";
import type {
  SessionLoadDiagnosticCode
} from "./types.js";
import { ensureDirectory, sanitizeSessionId } from "./utils.js";

export function quarantineFile(params: {
  sessionDirectory: string;
  sessionId: string;
  sourceFilePath: string;
}): string | undefined {
  try {
    const corruptDir = sessionCorruptDirectoryPath(params.sessionDirectory);
    ensureDirectory(corruptDir);
    const ext = path.extname(params.sourceFilePath);
    const target = path.join(
      corruptDir,
      `${sanitizeSessionId(params.sessionId)}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext || ".jsonl"}`
    );
    fs.renameSync(params.sourceFilePath, target);
    return target;
  } catch {
    return undefined;
  }
}

export function readSessionMessagesFromJsonl(filePath: string): {
  ok: true;
  history: ChatMessage[];
} | {
  ok: false;
  code: SessionLoadDiagnosticCode;
  message: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: true,
        history: []
      };
    }
    return {
      ok: false,
      code: "invalid_shape",
      message: err.message || String(error)
    };
  }

  const history: ChatMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        ok: false,
        code: "corrupt_json",
        message: error instanceof Error ? error.message : String(error)
      };
    }

    const message = parseSessionMessageLine(parsed);
    if (message) {
      history.push(message);
      continue;
    }

    const eventLine = parseSessionEventLine(parsed);
    if (eventLine) {
      continue;
    }

    return {
      ok: false,
      code: "invalid_shape",
      message: "Session JSONL line has invalid shape"
    };
  }

  return {
    ok: true,
    history
  };
}

export function readSerializedEventLines(filePath: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const serialized: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const eventLine = parseSessionEventLine(parsed);
      if (!eventLine) {
        continue;
      }
      serialized.push(JSON.stringify(eventLine));
    } catch {
      // ignore invalid event lines while preserving readable event log
    }
  }
  return serialized;
}

export function isHistoryPrefix(previous: ChatMessage[], next: ChatMessage[]): boolean {
  if (previous.length > next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) {
      return false;
    }
    if (left.role !== right.role || left.content !== right.content || left.createdAt !== right.createdAt) {
      return false;
    }
  }
  return true;
}
