import type { ChatMessage } from "./types.js";
import { loadSessionRecord, saveSessionRecord } from "./sessions.js";

function nowIso(): string {
  return new Date().toISOString();
}

function truncateLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function flattenMessageContent(content: string): string {
  return truncateLine(content, 320);
}

function filterSourceMessages(history: ChatMessage[]): ChatMessage[] {
  const filtered: ChatMessage[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") {
      continue;
    }
    const flattened = flattenMessageContent(message.content);
    if (!flattened) {
      continue;
    }
    if (flattened.includes("[Session continuity summary from ")) {
      continue;
    }
    filtered.push({
      role: message.role,
      content: flattened,
      createdAt: message.createdAt
    });
  }
  return filtered;
}

function buildContinuitySummary(params: {
  fromSessionId: string;
  messages: ChatMessage[];
  summaryMaxChars: number;
}): string {
  const clipped = params.messages.slice(-40);
  const objective = clipped.find((message) => message.role === "user")?.content ?? "Continue assisting based on prior session context.";
  const decisions = clipped
    .filter((message) => message.role === "assistant")
    .slice(-8)
    .map((message) => `- ${truncateLine(message.content, 180)}`)
    .join("\n");
  const openThreads = clipped
    .filter((message) => message.role === "user")
    .slice(-8)
    .map((message) => `- ${truncateLine(message.content, 180)}`)
    .join("\n");
  const timeline = clipped
    .slice(-16)
    .map((message) => `[${message.role}] ${truncateLine(message.content, 220)}`)
    .join("\n");

  const body = [
    "## Session Continuity",
    "### Core Objective",
    objective,
    "",
    "### Decisions and Constraints",
    decisions || "- No explicit decisions recorded.",
    "",
    "### Open Threads",
    openThreads || "- No unresolved threads recorded.",
    "",
    "### Timeline Excerpt",
    timeline || "- No timeline available."
  ].join("\n");

  if (body.length <= params.summaryMaxChars) {
    return body;
  }
  return body.slice(0, Math.max(0, params.summaryMaxChars - 4)).trimEnd() + "\n...";
}

export interface SessionContinuityConfig {
  enabled?: boolean;
  autoOnNew?: boolean;
  sourceMaxMessages?: number;
  sourceMaxChars?: number;
  summaryMaxChars?: number;
  notifyOnComplete?: boolean;
  maxParallelJobs?: number;
}

export type SessionContinuityStatus = "queued" | "running" | "completed" | "failed";

export interface SessionContinuityJobRecord {
  jobId: string;
  fromSessionId: string;
  toSessionId: string;
  status: SessionContinuityStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface SessionContinuityTask {
  jobId: string;
  fromSessionId: string;
  toSessionId: string;
}

export class SessionContinuityRuntime {
  private readonly config: Required<SessionContinuityConfig>;
  private readonly sessionDirectory: string;
  private readonly lockOptions?: { timeoutMs?: number; staleMs?: number };
  private readonly jobs = new Map<string, SessionContinuityJobRecord>();
  private readonly queue: SessionContinuityTask[] = [];
  private activeCount = 0;

  constructor(params: {
    config?: SessionContinuityConfig;
    sessionDirectory: string;
    lockOptions?: { timeoutMs?: number; staleMs?: number };
  }) {
    this.config = {
      enabled: params.config?.enabled ?? false,
      autoOnNew: params.config?.autoOnNew ?? true,
      sourceMaxMessages: Math.max(1, params.config?.sourceMaxMessages ?? 400),
      sourceMaxChars: Math.max(500, params.config?.sourceMaxChars ?? 120_000),
      summaryMaxChars: Math.max(500, params.config?.summaryMaxChars ?? 32_000),
      notifyOnComplete: params.config?.notifyOnComplete ?? false,
      maxParallelJobs: Math.max(1, params.config?.maxParallelJobs ?? 1)
    };
    this.sessionDirectory = params.sessionDirectory;
    this.lockOptions = params.lockOptions;
  }

  enabled(): boolean {
    return this.config.enabled && this.config.autoOnNew;
  }

  listJobs(limit = 50): SessionContinuityJobRecord[] {
    const jobs = Array.from(this.jobs.values()).sort((left, right) => {
      return Date.parse(right.queuedAt) - Date.parse(left.queuedAt);
    });
    if (limit <= 0) {
      return [];
    }
    return jobs.slice(0, limit);
  }

  getJob(jobId: string): SessionContinuityJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  schedule(params: { fromSessionId: string; toSessionId: string }): SessionContinuityJobRecord | null {
    if (!this.enabled()) {
      return null;
    }
    const fromSessionId = params.fromSessionId.trim();
    const toSessionId = params.toSessionId.trim();
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
      return null;
    }

    const jobId = `cont-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const record: SessionContinuityJobRecord = {
      jobId,
      fromSessionId,
      toSessionId,
      status: "queued",
      queuedAt: nowIso()
    };
    this.jobs.set(jobId, record);
    this.queue.push({
      jobId,
      fromSessionId,
      toSessionId
    });
    this.drainQueue();
    return record;
  }

  private drainQueue(): void {
    while (this.activeCount < this.config.maxParallelJobs && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      this.activeCount += 1;
      void this.runTask(next).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.drainQueue();
      });
    }
  }

  private async runTask(task: SessionContinuityTask): Promise<void> {
    const record = this.jobs.get(task.jobId);
    if (!record) {
      return;
    }
    record.status = "running";
    record.startedAt = nowIso();

    try {
      const source = loadSessionRecord(this.sessionDirectory, task.fromSessionId);
      const target = loadSessionRecord(this.sessionDirectory, task.toSessionId);
      if (!source || !target) {
        throw new Error("Session not found for continuity transfer");
      }

      let filtered = filterSourceMessages(source.history);
      if (filtered.length > this.config.sourceMaxMessages) {
        filtered = filtered.slice(-this.config.sourceMaxMessages);
      }

      let rollingChars = 0;
      const bounded: ChatMessage[] = [];
      for (let index = filtered.length - 1; index >= 0; index -= 1) {
        const message = filtered[index];
        if (!message) {
          continue;
        }
        rollingChars += message.content.length;
        if (rollingChars > this.config.sourceMaxChars) {
          break;
        }
        bounded.push(message);
      }
      bounded.reverse();

      const summary = buildContinuitySummary({
        fromSessionId: task.fromSessionId,
        messages: bounded,
        summaryMaxChars: this.config.summaryMaxChars
      });

      const continuityMessage: ChatMessage = {
        role: "user",
        content: `[Session continuity summary from ${task.fromSessionId}]\n${summary}\n[End continuity summary]`,
        createdAt: nowIso()
      };

      const nextHistory = [...target.history, continuityMessage];
      saveSessionRecord({
        sessionDirectory: this.sessionDirectory,
        sessionId: task.toSessionId,
        activeProviderId: target.activeProviderId,
        pendingProviderId: target.pendingProviderId,
        history: nextHistory,
        metadata: {
          ...target.metadata,
          lastActivityAt: nowIso()
        },
        lock: this.lockOptions
      });

      record.status = "completed";
      record.completedAt = nowIso();
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = nowIso();
    }
  }
}
