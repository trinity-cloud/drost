import type { GatewaySubagentsConfig } from "../config.js";
import { SubagentStore } from "./store.js";
import type {
  SubagentCancelResult,
  SubagentJobRecord,
  SubagentJobStatus,
  SubagentLogRecord,
  SubagentManagerParams,
  SubagentManagerStatus,
  SubagentStartRequest,
  SubagentStartResult
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function createJobId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunningJob {
  controller: AbortController;
  timeout: NodeJS.Timeout;
  timeoutTriggered: boolean;
  cancelRequested: boolean;
}

export class SubagentManager {
  private readonly config: Required<Pick<GatewaySubagentsConfig, "enabled" | "maxParallelJobs" | "defaultTimeoutMs" | "allowNested" | "lockMode">>;
  private readonly store: SubagentStore;
  private readonly runtime: SubagentManagerParams["runtime"];
  private readonly jobs = new Map<string, SubagentJobRecord>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, RunningJob>();
  private started = false;
  private stopping = false;

  constructor(params: SubagentManagerParams) {
    this.config = {
      enabled: params.config?.enabled ?? false,
      maxParallelJobs: Math.max(1, Math.floor(params.config?.maxParallelJobs ?? 2)),
      defaultTimeoutMs: Math.max(50, Math.floor(params.config?.defaultTimeoutMs ?? 120_000)),
      allowNested: params.config?.allowNested ?? false,
      lockMode: params.config?.lockMode ?? "none"
    };
    this.store = new SubagentStore(params.workspaceDir);
    this.runtime = params.runtime;
  }

  private effectiveParallelism(): number {
    if (this.config.lockMode === "workspace" || this.config.lockMode === "exclusive") {
      return 1;
    }
    return this.config.maxParallelJobs;
  }

  private persistJob(job: SubagentJobRecord): void {
    this.jobs.set(job.jobId, job);
    this.store.saveJob(job);
    this.runtime.onStatusChange?.({ ...job });
  }

  private log(jobId: string, level: SubagentLogRecord["level"], message: string, payload?: Record<string, unknown>): void {
    this.store.appendLog(jobId, {
      timestamp: nowIso(),
      level,
      message,
      payload
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.store.ensureLayout();
    const persisted = this.store.listJobs();
    for (const job of persisted) {
      if (!job || typeof job.jobId !== "string" || job.jobId.trim().length === 0) {
        continue;
      }
      const normalized: SubagentJobRecord = {
        ...job,
        status:
          job.status === "queued" || job.status === "running"
            ? "queued"
            : job.status,
        updatedAt: nowIso(),
        recovered: job.status === "queued" || job.status === "running" ? true : job.recovered
      };
      this.jobs.set(normalized.jobId, normalized);
      if (normalized.status === "queued") {
        this.queue.push(normalized.jobId);
        this.persistJob(normalized);
      }
    }
    this.drainQueue();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const [jobId, running] of this.running.entries()) {
      running.cancelRequested = true;
      running.controller.abort();
      clearTimeout(running.timeout);
      this.running.delete(jobId);
      const job = this.jobs.get(jobId);
      if (!job) {
        continue;
      }
      const updated: SubagentJobRecord = {
        ...job,
        status: "queued",
        updatedAt: nowIso(),
        recovered: true
      };
      this.persistJob(updated);
      if (!this.queue.includes(jobId)) {
        this.queue.push(jobId);
      }
    }
    this.started = false;
    this.stopping = false;
  }

  private canStartSession(sessionId: string): boolean {
    if (this.config.allowNested) {
      return true;
    }
    return !sessionId.includes(":subagent:");
  }

  startJob(request: SubagentStartRequest): SubagentStartResult {
    if (!this.config.enabled) {
      return {
        ok: false,
        message: "Subagents are disabled"
      };
    }
    const sessionId = request.sessionId.trim();
    const input = request.input.trim();
    if (!sessionId || !input) {
      return {
        ok: false,
        message: "sessionId and input are required"
      };
    }
    if (!this.canStartSession(sessionId)) {
      return {
        ok: false,
        message: "Nested subagent execution is disabled"
      };
    }

    const jobId = createJobId();
    const createdAt = nowIso();
    const timeoutMs = Math.max(50, Math.floor(request.timeoutMs ?? this.config.defaultTimeoutMs));
    const job: SubagentJobRecord = {
      jobId,
      sessionId,
      status: "queued",
      input,
      providerId: request.providerId?.trim() || undefined,
      subSessionId: `${sessionId}:subagent:${jobId}`,
      timeoutMs,
      createdAt,
      updatedAt: createdAt
    };

    this.persistJob(job);
    this.store.appendSessionJob(sessionId, jobId);
    this.queue.push(jobId);
    this.log(jobId, "info", "Job queued", {
      sessionId,
      timeoutMs
    });
    this.drainQueue();

    return {
      ok: true,
      message: "Subagent job queued",
      job
    };
  }

  private updateStatus(job: SubagentJobRecord, status: SubagentJobStatus, extra?: Partial<SubagentJobRecord>): SubagentJobRecord {
    const updated: SubagentJobRecord = {
      ...job,
      ...extra,
      status,
      updatedAt: nowIso(),
      finishedAt:
        status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out"
          ? nowIso()
          : job.finishedAt
    };
    this.persistJob(updated);
    return updated;
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") {
      return;
    }

    const controller = new AbortController();
    const runningState: RunningJob = {
      controller,
      timeoutTriggered: false,
      cancelRequested: false,
      timeout: setTimeout(() => {
        const current = this.running.get(jobId);
        if (!current) {
          return;
        }
        current.timeoutTriggered = true;
        current.controller.abort();
      }, job.timeoutMs)
    };
    this.running.set(jobId, runningState);

    const startedAt = nowIso();
    const runningJob = this.updateStatus(job, "running", {
      startedAt,
      error: undefined,
      result: undefined
    });
    this.log(jobId, "info", "Job started", {
      subSessionId: runningJob.subSessionId
    });

    try {
      const result = await this.runtime.runDelegatedTurn({
        jobId,
        sessionId: runningJob.sessionId,
        subSessionId: runningJob.subSessionId,
        input: runningJob.input,
        providerId: runningJob.providerId,
        signal: controller.signal
      });

      this.updateStatus(runningJob, "completed", {
        result: {
          response: result.response
        },
        error: undefined
      });
      this.log(jobId, "info", "Job completed", {
        responseChars: result.response.length
      });
    } catch (error) {
      const running = this.running.get(jobId);
      const timeoutTriggered = running?.timeoutTriggered === true;
      const cancelRequested = running?.cancelRequested === true;
      if (timeoutTriggered) {
        this.updateStatus(runningJob, "timed_out", {
          error: {
            code: "timeout",
            message: `Job exceeded timeout (${runningJob.timeoutMs}ms)`
          }
        });
        this.log(jobId, "warn", "Job timed out", {
          timeoutMs: runningJob.timeoutMs
        });
      } else if (cancelRequested || controller.signal.aborted) {
        this.updateStatus(runningJob, "cancelled", {
          error: {
            code: "cancelled",
            message: "Job cancelled"
          }
        });
        this.log(jobId, "warn", "Job cancelled");
      } else {
        const message = toErrorText(error);
        this.updateStatus(runningJob, "failed", {
          error: {
            code: "execution_error",
            message
          }
        });
        this.log(jobId, "error", "Job failed", {
          message
        });
      }
    } finally {
      const running = this.running.get(jobId);
      if (running) {
        clearTimeout(running.timeout);
      }
      this.running.delete(jobId);
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (!this.started || this.stopping || !this.config.enabled) {
      return;
    }

    while (this.running.size < this.effectiveParallelism() && this.queue.length > 0) {
      const nextJobId = this.queue.shift();
      if (!nextJobId) {
        break;
      }
      const nextJob = this.jobs.get(nextJobId);
      if (!nextJob || nextJob.status !== "queued") {
        continue;
      }
      void this.executeJob(nextJobId);
    }
  }

  cancelJob(jobId: string): SubagentCancelResult {
    const normalizedJobId = jobId.trim();
    if (!normalizedJobId) {
      return {
        ok: false,
        message: "jobId is required"
      };
    }

    const job = this.jobs.get(normalizedJobId);
    if (!job) {
      return {
        ok: false,
        message: `Unknown subagent job: ${normalizedJobId}`
      };
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "timed_out") {
      return {
        ok: false,
        message: `Job ${normalizedJobId} is already finished`,
        job
      };
    }

    const queueIndex = this.queue.indexOf(normalizedJobId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      const updated = this.updateStatus(job, "cancelled", {
        error: {
          code: "cancelled",
          message: "Job cancelled before execution"
        }
      });
      this.log(normalizedJobId, "warn", "Job cancelled while queued");
      return {
        ok: true,
        message: `Cancelled ${normalizedJobId}`,
        job: updated
      };
    }

    const running = this.running.get(normalizedJobId);
    if (running) {
      running.cancelRequested = true;
      running.controller.abort();
      return {
        ok: true,
        message: `Cancellation requested for ${normalizedJobId}`,
        job
      };
    }

    return {
      ok: false,
      message: `Job ${normalizedJobId} is not cancellable`,
      job
    };
  }

  getJob(jobId: string): SubagentJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(params?: {
    sessionId?: string;
    limit?: number;
  }): SubagentJobRecord[] {
    const limit = params?.limit && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 50;
    let jobs = Array.from(this.jobs.values());
    if (params?.sessionId) {
      const sessionId = params.sessionId.trim();
      jobs = jobs.filter((job) => job.sessionId === sessionId);
    }
    jobs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return jobs.slice(0, limit).map((job) => ({ ...job }));
  }

  listSessionJobs(sessionId: string, limit = 50): SubagentJobRecord[] {
    const ids = this.store.sessionJobs(sessionId);
    const jobs: SubagentJobRecord[] = [];
    for (const id of ids) {
      const job = this.jobs.get(id) ?? this.store.loadJob(id);
      if (!job) {
        continue;
      }
      jobs.push(job);
    }
    jobs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return jobs.slice(0, limit).map((job) => ({ ...job }));
  }

  readJobLogs(jobId: string, limit = 200): SubagentLogRecord[] {
    return this.store.readLogs(jobId, limit);
  }

  getStatus(): SubagentManagerStatus {
    return {
      enabled: this.config.enabled,
      maxParallelJobs: this.config.maxParallelJobs,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      allowNested: this.config.allowNested,
      lockMode: this.config.lockMode,
      queued: this.queue.length,
      running: this.running.size,
      total: this.jobs.size
    };
  }
}
