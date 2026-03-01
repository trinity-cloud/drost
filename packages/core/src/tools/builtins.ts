import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertPathInMutableRoots, resolveWorkspacePath } from "../path-policy.js";
import { defineTool } from "./definition.js";
import {
  agentToolSchema,
  fileToolSchema,
  shellToolSchema,
  subagentCancelToolSchema,
  subagentListToolSchema,
  subagentLogToolSchema,
  subagentPollToolSchema,
  subagentStartToolSchema,
  webToolSchema
} from "./schemas.js";
import { createCodeSearchAndReadTools } from "./builtins-code-search-read.js";
import { createCodeGitTools } from "./builtins-code-git.js";
import type {
  BuiltInToolFactoryParams,
  ShellToolPolicy,
  ToolContext,
  ToolDefinition
} from "./types.js";

const execFileAsync = promisify(execFile);

async function collectDirectoryEntries(params: {
  workspaceDir: string;
  rootAbsolute: string;
  rootRelative: string;
  recursive: boolean;
  includeHidden: boolean;
  maxEntries: number;
}): Promise<{ entries: Array<{ path: string; type: "file" | "directory"; size?: number }>; truncated: boolean }> {
  const queue: Array<{ absolute: string; relative: string }> = [
    {
      absolute: params.rootAbsolute,
      relative: params.rootRelative
    }
  ];
  const entries: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  let truncated = false;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    const dirEntries = await fs.readdir(next.absolute, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirEntry of dirEntries) {
      if (!params.includeHidden && dirEntry.name.startsWith(".")) {
        continue;
      }

      const absolute = path.join(next.absolute, dirEntry.name);
      const relative = next.relative === "." ? dirEntry.name : path.posix.join(next.relative, dirEntry.name);
      const itemType: "file" | "directory" = dirEntry.isDirectory() ? "directory" : "file";
      const item: { path: string; type: "file" | "directory"; size?: number } = {
        path: relative,
        type: itemType
      };

      if (itemType === "file") {
        try {
          const stat = await fs.stat(absolute);
          item.size = stat.size;
        } catch {
          // best effort size
        }
      }

      entries.push(item);
      if (entries.length >= params.maxEntries) {
        truncated = true;
        return { entries, truncated };
      }

      if (params.recursive && dirEntry.isDirectory()) {
        queue.push({
          absolute,
          relative
        });
      }
    }
  }

  return { entries, truncated };
}

function countOccurrences(input: string, search: string): number {
  let count = 0;
  let index = input.indexOf(search);
  while (index >= 0) {
    count += 1;
    index = input.indexOf(search, index + search.length);
  }
  return count;
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

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractExaResults(payload: unknown, limit: number): Array<{ title: string; snippet: string; url: string }> {
  const results: Array<{ title: string; snippet: string; url: string }> = [];
  if (!payload || typeof payload !== "object") {
    return results;
  }

  const record = payload as Record<string, unknown>;
  const rawResults = Array.isArray(record.results) ? record.results : [];

  for (const item of rawResults) {
    if (results.length >= limit || !item || typeof item !== "object") {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) {
      continue;
    }

    const title =
      typeof entry.title === "string" && entry.title.trim().length > 0
        ? entry.title.trim()
        : url;

    const firstHighlight = Array.isArray(entry.highlights)
      ?
          entry.highlights.find(
            (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
          ) ?? ""
      : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const text = typeof entry.text === "string" ? entry.text : "";
    const snippet =
      truncateInlineText(summary, 280) ||
      truncateInlineText(firstHighlight, 280) ||
      truncateInlineText(text, 280) ||
      "";

    results.push({
      title,
      snippet,
      url
    });
  }
  return results;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim();
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedPrefix) {
    return false;
  }
  return command === normalizedPrefix || command.startsWith(`${normalizedPrefix} `);
}

function enforceShellPolicy(command: string, policy: ShellToolPolicy | undefined): void {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    throw new Error("Shell command is required");
  }

  const denyPrefixes = (policy?.denyCommandPrefixes ?? []).map(normalizePrefix).filter((prefix) => prefix.length > 0);
  for (const prefix of denyPrefixes) {
    if (commandMatchesPrefix(normalizedCommand, prefix)) {
      throw new Error(`Shell command denied by policy: ${prefix}`);
    }
  }

  const allowPrefixes = (policy?.allowCommandPrefixes ?? []).map(normalizePrefix).filter((prefix) => prefix.length > 0);
  if (allowPrefixes.length === 0) {
    return;
  }
  const matched = allowPrefixes.some((prefix) => commandMatchesPrefix(normalizedCommand, prefix));
  if (!matched) {
    throw new Error("Shell command denied by allow-list policy");
  }
}

function resolveMutableWorkspacePath(context: ToolContext, requestedPath: string): {
  absolute: string;
  relative: string;
} {
  const resolved = resolveWorkspacePath(context.workspaceDir, requestedPath);
  assertPathInMutableRoots({
    targetPath: resolved.absolute,
    mutableRoots: context.mutableRoots,
    requestedPath
  });
  return resolved;
}

export function createDefaultBuiltInTools(params: BuiltInToolFactoryParams = {}): ToolDefinition[] {
  const fetchImpl = params.fetchImpl ?? fetch;

  const fileTool = defineTool({
    name: "file",
    description: "Read, write, list, and edit files in the workspace",
    parameters: fileToolSchema,
    execute: async (rawInput, context) => {
      const input = fileToolSchema.parse(rawInput);
      if (input.action === "read") {
        const resolved = resolveMutableWorkspacePath(context, input.path);
        const content = await fs.readFile(resolved.absolute, input.encoding);
        return {
          action: input.action,
          path: resolved.relative,
          content
        };
      }

      if (input.action === "write") {
        const resolved = resolveMutableWorkspacePath(context, input.path);
        if (input.createDirs) {
          await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
        }

        if (input.mode === "append") {
          await fs.appendFile(resolved.absolute, input.content, "utf8");
        } else {
          await fs.writeFile(resolved.absolute, input.content, "utf8");
        }

        return {
          action: input.action,
          path: resolved.relative,
          mode: input.mode,
          bytesWritten: Buffer.byteLength(input.content, "utf8")
        };
      }

      if (input.action === "list") {
        const resolved = resolveMutableWorkspacePath(context, input.path);
        const stats = await fs.stat(resolved.absolute);
        if (!stats.isDirectory()) {
          throw new Error(`Not a directory: ${input.path}`);
        }
        const listed = await collectDirectoryEntries({
          workspaceDir: context.workspaceDir,
          rootAbsolute: resolved.absolute,
          rootRelative: resolved.relative,
          recursive: input.recursive,
          includeHidden: input.includeHidden,
          maxEntries: input.maxEntries
        });
        return {
          action: input.action,
          path: resolved.relative,
          recursive: input.recursive,
          truncated: listed.truncated,
          entries: listed.entries
        };
      }

      const resolved = resolveMutableWorkspacePath(context, input.path);
      const original = await fs.readFile(resolved.absolute, "utf8");
      const replacedCount = input.all ? countOccurrences(original, input.search) : original.includes(input.search) ? 1 : 0;
      if (replacedCount === 0) {
        return {
          action: input.action,
          path: resolved.relative,
          replacedCount: 0
        };
      }

      const updated = input.all
        ? original.split(input.search).join(input.replace)
        : original.replace(input.search, input.replace);
      await fs.writeFile(resolved.absolute, updated, "utf8");
      return {
        action: input.action,
        path: resolved.relative,
        replacedCount
      };
    }
  });

  const shellTool = defineTool({
    name: "shell",
    description: "Run a shell command",
    parameters: shellToolSchema,
    execute: async (rawInput, context) => {
      const input = shellToolSchema.parse(rawInput);
      enforceShellPolicy(input.command, params.shellPolicy);
      const timeoutMs = input.timeoutMs ?? params.shellPolicy?.timeoutMs;
      const maxBuffer = params.shellPolicy?.maxBufferBytes ?? 512 * 1024;
      const cwd = input.cwd
        ? resolveMutableWorkspacePath(context, input.cwd).absolute
        : context.workspaceDir;
      assertPathInMutableRoots({
        targetPath: cwd,
        mutableRoots: context.mutableRoots,
        requestedPath: input.cwd ?? "."
      });

      try {
        const result = await execFileAsync("sh", ["-lc", input.command], {
          cwd,
          timeout: timeoutMs ?? 0,
          maxBuffer,
          encoding: "utf8",
          env: input.env ? { ...process.env, ...input.env } : process.env
        });
        return {
          command: input.command,
          cwd: path.relative(context.workspaceDir, cwd) || ".",
          ok: true,
          exitCode: 0,
          stdout: toText(result.stdout),
          stderr: toText(result.stderr)
        };
      } catch (error) {
        const shellError = error as Error & {
          code?: number | string;
          signal?: string;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        return {
          command: input.command,
          cwd: path.relative(context.workspaceDir, cwd) || ".",
          ok: false,
          exitCode: typeof shellError.code === "number" ? shellError.code : null,
          signal: shellError.signal ?? null,
          stdout: toText(shellError.stdout),
          stderr: toText(shellError.stderr),
          message: shellError.message
        };
      }
    }
  });

  const webTool = defineTool({
    name: "web",
    description: "Fetch a URL or run web search",
    parameters: webToolSchema,
    execute: async (rawInput) => {
      const input = webToolSchema.parse(rawInput);
      if (input.action === "fetch") {
        const response = await fetchImpl(input.url, {
          method: input.method ?? "GET",
          headers: input.headers,
          body: input.body
        });
        const text = await response.text();
        const truncated = Buffer.byteLength(text, "utf8") > input.maxBytes;
        const body = truncated
          ? Buffer.from(text, "utf8").subarray(0, input.maxBytes).toString("utf8")
          : text;

        return {
          action: input.action,
          ok: response.ok,
          status: response.status,
          url: response.url,
          contentType: response.headers.get("content-type"),
          body,
          truncated
        };
      }

      const exaApiKey = process.env.EXA_API_KEY?.trim();
      if (!exaApiKey) {
        throw new Error("Web search requires EXA_API_KEY in the environment");
      }

      const response = await fetchImpl("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": exaApiKey
        },
        body: JSON.stringify({
          query: input.query,
          numResults: input.limit
        })
      });
      if (!response.ok) {
        const details = truncateInlineText(await response.text(), 200);
        const detailSuffix = details ? `: ${details}` : "";
        throw new Error(`Web search request failed with status ${response.status}${detailSuffix}`);
      }

      const payload = await response.json();
      return {
        action: input.action,
        query: input.query,
        provider: "exa",
        results: extractExaResults(payload, input.limit)
      };
    }
  });

  const agentTool = defineTool({
    name: "agent",
    description: "Read gateway status or request a runtime restart",
    parameters: agentToolSchema,
    execute: async (rawInput, context) => {
      const input = agentToolSchema.parse(rawInput);

      if (input.action === "status") {
        return {
          action: input.action,
          gateway: params.agent?.readStatus?.() ?? null,
          loadedTools: params.agent?.listLoadedToolNames?.() ?? [],
          sessions: params.agent?.listSessionSnapshots?.() ?? []
        };
      }

      if (!params.agent?.requestRestart) {
        throw new Error("Restart callback is not available");
      }

      const result = await params.agent.requestRestart({
        intent: "self_mod",
        reason: input.reason,
        sessionId: context.sessionId,
        providerId: context.providerId
      });
      if (result && typeof result === "object" && result.ok === false) {
        throw new Error(result.message ?? "Restart blocked by policy");
      }
      return {
        action: input.action,
        restartRequested: true,
        reason: input.reason ?? null
      };
    }
  });

  const subagentStartTool = defineTool({
    name: "subagent.start",
    description: "Start an asynchronous subagent job",
    parameters: subagentStartToolSchema,
    execute: async (rawInput, context) => {
      const input = subagentStartToolSchema.parse(rawInput);
      if (!params.agent?.startSubagent) {
        throw new Error("Subagent runtime is not available");
      }
      return params.agent.startSubagent({
        sessionId: input.sessionId?.trim() || context.sessionId,
        input: input.input,
        providerId: input.providerId,
        timeoutMs: input.timeoutMs
      });
    }
  });

  const subagentPollTool = defineTool({
    name: "subagent.poll",
    description: "Read a subagent job status",
    parameters: subagentPollToolSchema,
    execute: async (rawInput) => {
      const input = subagentPollToolSchema.parse(rawInput);
      if (!params.agent?.pollSubagent) {
        throw new Error("Subagent runtime is not available");
      }
      const job = params.agent.pollSubagent(input.jobId);
      if (!job) {
        throw new Error(`Unknown subagent job: ${input.jobId}`);
      }
      return {
        ok: true,
        job
      };
    }
  });

  const subagentListTool = defineTool({
    name: "subagent.list",
    description: "List subagent jobs",
    parameters: subagentListToolSchema,
    execute: async (rawInput) => {
      const input = subagentListToolSchema.parse(rawInput);
      if (!params.agent?.listSubagents) {
        throw new Error("Subagent runtime is not available");
      }
      return {
        ok: true,
        jobs: params.agent.listSubagents({
          sessionId: input.sessionId,
          limit: input.limit
        })
      };
    }
  });

  const subagentCancelTool = defineTool({
    name: "subagent.cancel",
    description: "Cancel a subagent job",
    parameters: subagentCancelToolSchema,
    execute: async (rawInput) => {
      const input = subagentCancelToolSchema.parse(rawInput);
      if (!params.agent?.cancelSubagent) {
        throw new Error("Subagent runtime is not available");
      }
      return params.agent.cancelSubagent(input.jobId);
    }
  });

  const subagentLogTool = defineTool({
    name: "subagent.log",
    description: "Read subagent logs",
    parameters: subagentLogToolSchema,
    execute: async (rawInput) => {
      const input = subagentLogToolSchema.parse(rawInput);
      if (!params.agent?.readSubagentLogs) {
        throw new Error("Subagent runtime is not available");
      }
      return {
        ok: true,
        logs: params.agent.readSubagentLogs(input.jobId, input.limit)
      };
    }
  });

  const builtIns: ToolDefinition[] = [
    fileTool,
    ...createCodeSearchAndReadTools(),
    ...createCodeGitTools(),
    shellTool,
    webTool,
    agentTool
  ];
  if (params.agent?.startSubagent) {
    builtIns.push(subagentStartTool, subagentPollTool, subagentListTool, subagentCancelTool, subagentLogTool);
  }
  return builtIns;
}
