import { spawn } from "node:child_process";
import type { NormalizedStreamEvent } from "../events.js";
import type { UsageSnapshot } from "../types.js";
import type {
  ProviderAdapter,
  ProviderProbeContext,
  ProviderProbeResult,
  ProviderProfile,
  ProviderTurnRequest
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function normalizeError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const withCode = error as Error & { code?: string | number };
  if (typeof withCode.code === "string" && withCode.code.length > 0) {
    return new Error(`${error.message} (${withCode.code})`);
  }
  return error;
}

function contains(text: string, pattern: string): boolean {
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function providerErrorEvent(params: {
  sessionId: string;
  providerId: string;
  message: string;
}): NormalizedStreamEvent {
  return {
    type: "provider.error",
    sessionId: params.sessionId,
    providerId: params.providerId,
    timestamp: nowIso(),
    payload: {
      error: params.message
    }
  };
}

function buildCodexPrompt(messages: ProviderTurnRequest["messages"]): string {
  const lines: string[] = [];
  lines.push("Conversation transcript:");
  for (const message of messages) {
    if (message.content.trim().length === 0) {
      continue;
    }
    lines.push(`${message.role.toUpperCase()}: ${message.content}`);
  }
  lines.push("");
  lines.push("Respond as ASSISTANT to the final USER message.");
  return lines.join("\n");
}

function parseUsage(value: unknown): UsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveModelArg(model: string): string | null {
  const normalized = model.trim();
  if (!normalized || normalized.toLowerCase() === "auto") {
    return null;
  }
  return normalized;
}

function isAssistantItemType(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "agent_message" || normalized === "assistant_message";
}

function extractDeltaText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.length > 0) {
    return record.text;
  }
  return null;
}

function extractAssistantDelta(record: Record<string, unknown>): { text: string; itemId?: string } | null {
  const eventType = typeof record.type === "string" ? record.type : "";
  if (eventType === "response.output_text.delta") {
    const text = extractDeltaText(record.delta);
    if (text) {
      const itemId =
        typeof record.item_id === "string"
          ? record.item_id
          : typeof record.itemId === "string"
            ? record.itemId
            : undefined;
      return { text, itemId };
    }
    return null;
  }

  if (eventType !== "item.delta") {
    return null;
  }

  const item = record.item;
  const itemRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
  const itemType = itemRecord?.type;
  if (itemType !== undefined && !isAssistantItemType(itemType)) {
    return null;
  }

  const itemId = typeof itemRecord?.id === "string" ? itemRecord.id : undefined;
  const text =
    extractDeltaText(record.delta) ??
    extractDeltaText(itemRecord?.delta) ??
    extractDeltaText(itemRecord?.text);
  if (!text) {
    return null;
  }
  return {
    text,
    itemId
  };
}

function mergeStreamText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    // Snapshot-style chunk with full text-so-far.
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    // Duplicate/stale chunk.
    return existing;
  }
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
    if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }
  return existing + incoming;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandRequest {
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutData?: (chunk: string) => void;
  onStderrData?: (chunk: string) => void;
}

type CommandRunner = (params: CommandRequest) => Promise<CommandResult>;

async function runCommand(params: CommandRequest): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn("codex", params.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceKillHandle: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
        forceKillHandle = undefined;
      }
      params.signal?.removeEventListener("abort", onAbort);
    };

    const finishResolve = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      finishReject(new Error("codex command aborted"));
    };

    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    params.signal?.addEventListener("abort", onAbort);

    const timeoutMs =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.max(0, params.timeoutMs)
        : 0;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        child.kill("SIGTERM");
        forceKillHandle = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 2000);
        forceKillHandle.unref?.();
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = toText(chunk);
      if (text.length === 0) {
        return;
      }
      stdout += text;
      params.onStdoutData?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = toText(chunk);
      if (text.length === 0) {
        return;
      }
      stderr += text;
      params.onStderrData?.(text);
    });

    child.once("error", (error) => {
      finishReject(normalizeError(error));
    });

    child.once("close", (code, signal) => {
      if (timedOut) {
        finishReject(new Error(`codex command timed out after ${params.timeoutMs}ms`));
        return;
      }
      if (params.signal?.aborted) {
        finishReject(new Error("codex command aborted"));
        return;
      }
      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }

      const detail = stderr.trim() || stdout.trim();
      const base = signal
        ? `codex exited via signal ${signal}`
        : `codex exited with code ${code ?? "unknown"}`;
      finishReject(new Error(detail.length > 0 ? `${base}: ${detail}` : base));
    });
  });
}

export class CodexExecAdapter implements ProviderAdapter {
  readonly id = "codex-exec";

  constructor(private readonly commandRunner: CommandRunner = runCommand) {}

  async probe(profile: ProviderProfile, context: ProviderProbeContext): Promise<ProviderProbeResult> {
    try {
      const result = await this.commandRunner({
        args: ["login", "status"],
        timeoutMs: context.timeoutMs
      });
      const combined = `${result.stdout}\n${result.stderr}`;
      if (contains(combined, "not logged in")) {
        return {
          providerId: profile.id,
          ok: false,
          code: "missing_auth",
          message: combined.trim() || "Codex CLI is not logged in"
        };
      }
      if (contains(combined, "logged in")) {
        return {
          providerId: profile.id,
          ok: true,
          code: "ok",
          message: "Codex CLI login is active"
        };
      }
      return {
        providerId: profile.id,
        ok: false,
        code: "missing_auth",
        message: combined.trim() || "Codex CLI is not logged in"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (contains(message, "not logged in")) {
        return {
          providerId: profile.id,
          ok: false,
          code: "missing_auth",
          message
        };
      }
      if (contains(message, "enoent")) {
        return {
          providerId: profile.id,
          ok: false,
          code: "provider_error",
          message: "Codex CLI binary not found in PATH"
        };
      }
      return {
        providerId: profile.id,
        ok: false,
        code: "provider_error",
        message
      };
    }
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    const prompt = buildCodexPrompt(request.messages);
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox"
    ];
    const modelArg = resolveModelArg(request.profile.model);
    if (modelArg) {
      args.push("--model", modelArg);
    }
    args.push(prompt);

    let responseText = "";
    let usage: UsageSnapshot | undefined;
    let stderr = "";
    let sawStdoutChunk = false;
    let sawStderrChunk = false;
    let stdoutBuffer = "";
    const streamedItemIds = new Set<string>();

    const emitResponseDelta = (text: string): void => {
      if (text.length === 0) {
        return;
      }
      request.emit({
        type: "response.delta",
        sessionId: request.sessionId,
        providerId: request.providerId,
        timestamp: nowIso(),
        payload: {
          text
        }
      });
    };

    const ingestAssistantText = (incoming: string): void => {
      const nextText = mergeStreamText(responseText, incoming);
      if (nextText === responseText) {
        return;
      }
      const delta = nextText.startsWith(responseText)
        ? nextText.slice(responseText.length)
        : incoming;
      if (delta.length === 0) {
        responseText = nextText;
        return;
      }
      emitResponseDelta(delta);
      responseText = nextText;
    };

    const processEventLine = (line: string): void => {
      const event = parseJsonLine(line);
      if (!event) {
        return;
      }

      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "turn.completed") {
        usage = parseUsage(event.usage) ?? usage;
        return;
      }

      const assistantDelta = extractAssistantDelta(event);
      if (assistantDelta) {
        if (assistantDelta.itemId) {
          streamedItemIds.add(assistantDelta.itemId);
        }
        ingestAssistantText(assistantDelta.text);
        return;
      }

      if (eventType === "item.completed") {
        const item = event.item;
        if (!item || typeof item !== "object") {
          return;
        }
        const itemRecord = item as Record<string, unknown>;
        if (!isAssistantItemType(itemRecord.type)) {
          return;
        }
        const itemId = typeof itemRecord.id === "string" ? itemRecord.id : undefined;
        if (itemId && streamedItemIds.has(itemId)) {
          return;
        }
        const text = typeof itemRecord.text === "string" ? itemRecord.text : "";
        if (text.length === 0) {
          return;
        }
        if (itemId) {
          streamedItemIds.add(itemId);
        }
        ingestAssistantText(text);
      }
    };

    const processStdoutChunk = (chunk: string): void => {
      if (chunk.length === 0) {
        return;
      }
      sawStdoutChunk = true;
      stdoutBuffer += chunk;
      let lineBreakIndex = stdoutBuffer.indexOf("\n");
      while (lineBreakIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, lineBreakIndex);
        stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
        processEventLine(rawLine);
        lineBreakIndex = stdoutBuffer.indexOf("\n");
      }
    };

    const flushStdoutBuffer = (): void => {
      if (stdoutBuffer.trim().length === 0) {
        stdoutBuffer = "";
        return;
      }
      processEventLine(stdoutBuffer);
      stdoutBuffer = "";
    };

    try {
      const result = await this.commandRunner({
        args,
        signal: request.signal,
        onStdoutData: (chunk) => {
          processStdoutChunk(chunk);
        },
        onStderrData: (chunk) => {
          sawStderrChunk = true;
          stderr += chunk;
        }
      });

      if (!sawStdoutChunk && result.stdout.length > 0) {
        processStdoutChunk(result.stdout);
      }
      flushStdoutBuffer();

      if (!sawStderrChunk && result.stderr.length > 0) {
        stderr += result.stderr;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(message);
    }

    if (responseText.length === 0 && stderr.trim().length > 0) {
      const message = stderr.trim();
      request.emit(providerErrorEvent({
        sessionId: request.sessionId,
        providerId: request.providerId,
        message
      }));
      throw new Error(message);
    }

    if (usage) {
      request.emit({
        type: "usage.updated",
        sessionId: request.sessionId,
        providerId: request.providerId,
        timestamp: nowIso(),
        payload: {
          usage
        }
      });
    }

    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: nowIso(),
      payload: {
        text: responseText,
        usage
      }
    });
  }
}
