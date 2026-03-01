import type { GatewaySubagentsConfig } from "../config.js";

export type SubagentJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface SubagentJobRecord {
  jobId: string;
  sessionId: string;
  status: SubagentJobStatus;
  input: string;
  providerId?: string;
  subSessionId: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  recovered?: boolean;
  result?: {
    response: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface SubagentLogRecord {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
}

export interface SubagentStartRequest {
  sessionId: string;
  input: string;
  providerId?: string;
  timeoutMs?: number;
}

export interface SubagentStartResult {
  ok: boolean;
  message: string;
  job?: SubagentJobRecord;
}

export interface SubagentCancelResult {
  ok: boolean;
  message: string;
  job?: SubagentJobRecord;
}

export interface SubagentManagerStatus {
  enabled: boolean;
  maxParallelJobs: number;
  defaultTimeoutMs: number;
  allowNested: boolean;
  lockMode: "none" | "workspace" | "exclusive";
  queued: number;
  running: number;
  total: number;
}

export interface SubagentManagerRuntime {
  runDelegatedTurn: (params: {
    jobId: string;
    sessionId: string;
    subSessionId: string;
    input: string;
    providerId?: string;
    signal: AbortSignal;
  }) => Promise<{
    response: string;
  }>;
  onStatusChange?: (job: SubagentJobRecord) => void;
}

export interface SubagentManagerParams {
  workspaceDir: string;
  config?: GatewaySubagentsConfig;
  runtime: SubagentManagerRuntime;
}
