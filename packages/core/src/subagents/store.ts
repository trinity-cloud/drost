import fs from "node:fs";
import path from "node:path";
import type { SubagentJobRecord, SubagentLogRecord } from "./types.js";

const SUBAGENTS_ROOT = path.join(".drost", "subagents");
const JOBS_DIR = "jobs";
const LOGS_DIR = "logs";
const SESSIONS_DIR = "sessions";

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function safeJobId(jobId: string): string {
  return encodeURIComponent(jobId);
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class SubagentStore {
  readonly rootDir: string;
  readonly jobsDir: string;
  readonly logsDir: string;
  readonly sessionsDir: string;

  constructor(workspaceDir: string) {
    this.rootDir = path.resolve(workspaceDir, SUBAGENTS_ROOT);
    this.jobsDir = path.join(this.rootDir, JOBS_DIR);
    this.logsDir = path.join(this.rootDir, LOGS_DIR);
    this.sessionsDir = path.join(this.rootDir, SESSIONS_DIR);
  }

  ensureLayout(): void {
    ensureDirectory(this.jobsDir);
    ensureDirectory(this.logsDir);
    ensureDirectory(this.sessionsDir);
  }

  private jobPath(jobId: string): string {
    return path.join(this.jobsDir, `${safeJobId(jobId)}.json`);
  }

  private logPath(jobId: string): string {
    return path.join(this.logsDir, `${safeJobId(jobId)}.jsonl`);
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${safeSessionId(sessionId)}.json`);
  }

  saveJob(job: SubagentJobRecord): void {
    atomicWriteJson(this.jobPath(job.jobId), job);
  }

  loadJob(jobId: string): SubagentJobRecord | null {
    return readJsonFile<SubagentJobRecord>(this.jobPath(jobId));
  }

  listJobs(): SubagentJobRecord[] {
    this.ensureLayout();
    const records: SubagentJobRecord[] = [];
    for (const entry of fs.readdirSync(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const parsed = readJsonFile<SubagentJobRecord>(path.join(this.jobsDir, entry.name));
      if (parsed) {
        records.push(parsed);
      }
    }
    return records;
  }

  appendLog(jobId: string, log: SubagentLogRecord): void {
    ensureDirectory(this.logsDir);
    fs.appendFileSync(this.logPath(jobId), `${JSON.stringify(log)}\n`, "utf8");
  }

  readLogs(jobId: string, limit = 200): SubagentLogRecord[] {
    if (limit <= 0) {
      return [];
    }
    const logPath = this.logPath(jobId);
    if (!fs.existsSync(logPath)) {
      return [];
    }
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const parsed: SubagentLogRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        parsed.push(JSON.parse(line) as SubagentLogRecord);
      } catch {
        // ignore invalid log lines
      }
    }
    return parsed;
  }

  appendSessionJob(sessionId: string, jobId: string): void {
    const filePath = this.sessionPath(sessionId);
    const current = readJsonFile<{ sessionId: string; jobs: string[] }>(filePath) ?? {
      sessionId,
      jobs: []
    };
    if (!current.jobs.includes(jobId)) {
      current.jobs.push(jobId);
    }
    atomicWriteJson(filePath, current);
  }

  sessionJobs(sessionId: string): string[] {
    const parsed = readJsonFile<{ sessionId: string; jobs: string[] }>(this.sessionPath(sessionId));
    if (!parsed || !Array.isArray(parsed.jobs)) {
      return [];
    }
    return parsed.jobs
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}
