import { execFile } from "node:child_process";
import { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalizePath, isWithinRoot, resolveWorkspacePath } from "./path-policy.js";
import { importTypeScriptModule, unwrapModuleDefault } from "./module-loader.js";

const execFileAsync = promisify(execFile);
const CUSTOM_TOOL_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const DEFAULT_MAX_WEB_BODY_BYTES = 120_000;

export interface ToolContext {
  workspaceDir: string;
  mutableRoots: string[];
  sessionId: string;
  providerId: string;
}

export interface ToolValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ToolValidationError {
  code: "validation_error";
  message: string;
  issues: ToolValidationIssue[];
}

export interface ToolExecutionError {
  code: "execution_error";
  message: string;
}

export type ToolFailure = ToolValidationError | ToolExecutionError;

export interface ToolParameterSchema<TInput = unknown> {
  safeParse: (
    input: unknown
  ) =>
    | {
        success: true;
        data: TInput;
      }
    | {
        success: false;
        error: unknown;
      };
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: ToolParameterSchema<unknown>;
  execute: (input: unknown, context: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolDefinitionSpec<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  parameters?: ToolParameterSchema<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput> | TOutput;
}

export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: ToolFailure;
}

export interface ShellToolPolicy {
  allowCommandPrefixes?: string[];
  denyCommandPrefixes?: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface AgentToolRuntime {
  requestRestart?: (params?: {
    intent?: "manual" | "self_mod" | "config_change" | "signal";
    reason?: string;
    dryRun?: boolean;
    sessionId?: string;
    providerId?: string;
  }) => Promise<{ ok?: boolean; message?: string } | void>;
  readStatus?: () => unknown;
  listLoadedToolNames?: () => string[];
  listSessionSnapshots?: () => Array<{
    sessionId: string;
    activeProviderId: string;
    pendingProviderId?: string;
    turnInProgress: boolean;
    historyCount: number;
  }>;
}

export interface BuiltInToolFactoryParams {
  shellPolicy?: ShellToolPolicy;
  agent?: AgentToolRuntime;
  fetchImpl?: typeof fetch;
}

export type ToolSkipReason =
  | "import_error"
  | "invalid_shape"
  | "name_collision"
  | "duplicate_custom_name";

export interface ToolSkipDiagnostic {
  filePath: string;
  reason: ToolSkipReason;
  message: string;
  toolName?: string;
}

export interface ToolRegistryDiagnostics {
  loadedBuiltInCount: number;
  loadedCustomCount: number;
  skipped: ToolSkipDiagnostic[];
}

export interface ToolRegistryResult {
  tools: Map<string, ToolDefinition>;
  diagnostics: ToolRegistryDiagnostics;
}

const fileToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    path: z.string().min(1),
    encoding: z.enum(["utf8"]).optional().default("utf8")
  }),
  z.object({
    action: z.literal("write"),
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(["overwrite", "append"]).optional().default("overwrite"),
    createDirs: z.boolean().optional().default(true)
  }),
  z.object({
    action: z.literal("list"),
    path: z.string().optional().default("."),
    recursive: z.boolean().optional().default(false),
    includeHidden: z.boolean().optional().default(false),
    maxEntries: z.number().int().positive().max(2_000).optional().default(200)
  }),
  z.object({
    action: z.literal("edit"),
    path: z.string().min(1),
    search: z.string().min(1),
    replace: z.string(),
    all: z.boolean().optional().default(false)
  })
]);

const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional()
});

const webToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("fetch"),
    url: z.string().url(),
    method: z.string().optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    maxBytes: z.number().int().positive().max(2_000_000).optional().default(DEFAULT_MAX_WEB_BODY_BYTES)
  }),
  z.object({
    action: z.literal("search"),
    query: z.string().min(1),
    limit: z.number().int().positive().max(10).optional().default(5)
  })
]);

const agentToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status")
  }),
  z.object({
    action: z.literal("restart"),
    reason: z.string().optional()
  })
]);

const codeSearchToolSchema = z.object({
  query: z.string().min(1),
  globInclude: z.array(z.string().min(1)).optional(),
  globExclude: z.array(z.string().min(1)).optional(),
  maxResults: z.number().int().positive().max(500).optional().default(50),
  literal: z.boolean().optional().default(false)
});

const codeReadContextToolSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    anchor: z.string().min(1).optional(),
    anchorMode: z.enum(["literal", "regex"]).optional().default("literal"),
    occurrence: z.number().int().positive().max(1_000).optional().default(1),
    before: z.number().int().min(0).max(400).optional().default(20),
    after: z.number().int().min(0).max(400).optional().default(40)
  })
  .refine((value) => value.line !== undefined || value.anchor !== undefined, {
    message: "line or anchor is required"
  });

const codeStatusToolSchema = z.object({
  scope: z.enum(["mutable_roots", "workspace"]).optional().default("mutable_roots")
});

const codeDiffToolSchema = z.object({
  mode: z.enum(["worktree_vs_head", "between_revisions"]).optional().default("worktree_vs_head"),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  maxBytes: z.number().int().positive().max(2_000_000).optional().default(200_000)
});

const codePatchToolSchema = z.object({
  patch: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
  expectedBase: z
    .object({
      kind: z.literal("git_head"),
      value: z.string().min(1)
    })
    .optional()
});

function isSchemaLike(value: unknown): value is ToolParameterSchema {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as { safeParse?: unknown }).safeParse === "function";
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: ToolDefinitionSpec<TInput, TOutput>
): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

function asToolDefinition(value: unknown): ToolDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ToolDefinition>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return null;
  }
  if (typeof candidate.execute !== "function") {
    return null;
  }
  if (candidate.parameters !== undefined && !isSchemaLike(candidate.parameters)) {
    return null;
  }

  return {
    name: candidate.name.trim(),
    description: typeof candidate.description === "string" ? candidate.description : undefined,
    parameters: candidate.parameters,
    execute: candidate.execute
  };
}

function normalizeValidationIssues(error: unknown): ToolValidationIssue[] {
  if (!error || typeof error !== "object") {
    return [];
  }

  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return [];
  }

  const normalized: ToolValidationIssue[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueRecord = issue as {
      path?: unknown;
      message?: unknown;
      code?: unknown;
    };

    const pathParts = Array.isArray(issueRecord.path)
      ? issueRecord.path.map((part) => String(part))
      : [];
    normalized.push({
      path: pathParts.length > 0 ? pathParts.join(".") : "$",
      message: typeof issueRecord.message === "string" ? issueRecord.message : "Invalid value",
      code: typeof issueRecord.code === "string" ? issueRecord.code : undefined
    });
  }
  return normalized;
}

export function validateToolInput(
  tool: ToolDefinition,
  input: unknown
):
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: ToolValidationError;
    } {
  if (!tool.parameters) {
    return {
      ok: true,
      value: input
    };
  }

  const parsed = tool.parameters.safeParse(input);
  if (parsed.success) {
    return {
      ok: true,
      value: parsed.data
    };
  }

  const issues = normalizeValidationIssues(parsed.error);
  const fallbackMessage =
    parsed.error && typeof parsed.error === "object" && typeof (parsed.error as { message?: unknown }).message === "string"
      ? ((parsed.error as { message?: unknown }).message as string)
      : "Tool input validation failed";

  return {
    ok: false,
    error: {
      code: "validation_error",
      message: issues[0]?.message ?? fallbackMessage,
      issues
    }
  };
}

export async function executeToolDefinition(params: {
  tool: ToolDefinition;
  input: unknown;
  context: ToolContext;
}): Promise<ToolExecutionResult> {
  const validation = validateToolInput(params.tool, params.input);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error
    };
  }

  try {
    const output = await params.tool.execute(validation.value, params.context);
    return {
      ok: true,
      output
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "execution_error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

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

function normalizePosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function workspaceRelativePath(workspaceDir: string, absolutePath: string): string {
  const relative = path.relative(canonicalizePath(workspaceDir), canonicalizePath(absolutePath));
  return relative.length > 0 ? normalizePosixPath(relative) : ".";
}

function resolveWorkspaceRelativeOrAbsolutePath(workspaceDir: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceDir, requestedPath);
}

function resolveMutableFilePath(context: ToolContext, requestedPath: string): { absolute: string; path: string } {
  const absolute = resolveWorkspaceRelativeOrAbsolutePath(context.workspaceDir, requestedPath);
  return {
    absolute,
    path: workspaceRelativePath(context.workspaceDir, absolute)
  };
}

function parseRipgrepLine(line: string): {
  path: string;
  line: number;
  column: number;
  preview: string;
} | null {
  if (!line.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "match") {
    return null;
  }
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  if (!data) {
    return null;
  }
  const pathNode = data.path && typeof data.path === "object" ? (data.path as Record<string, unknown>) : null;
  const linesNode = data.lines && typeof data.lines === "object" ? (data.lines as Record<string, unknown>) : null;
  const submatches = Array.isArray(data.submatches) ? data.submatches : [];
  if (!pathNode || !linesNode) {
    return null;
  }

  const matchPath = typeof pathNode.text === "string" ? pathNode.text : "";
  const preview = typeof linesNode.text === "string" ? linesNode.text.replace(/\r?\n$/, "") : "";
  const lineNumber =
    typeof data.line_number === "number" && Number.isFinite(data.line_number)
      ? Math.max(1, Math.floor(data.line_number))
      : 1;
  let column = 1;
  const firstSubmatch = submatches[0];
  if (firstSubmatch && typeof firstSubmatch === "object") {
    const start = (firstSubmatch as { start?: unknown }).start;
    if (typeof start === "number" && Number.isFinite(start)) {
      column = Math.max(1, Math.floor(start) + 1);
    }
  }

  if (!matchPath) {
    return null;
  }

  return {
    path: matchPath,
    line: lineNumber,
    column,
    preview
  };
}

function parseGrepLine(line: string): {
  path: string;
  line: number;
  column: number;
  preview: string;
} | null {
  const first = line.indexOf(":");
  if (first <= 0) {
    return null;
  }
  const second = line.indexOf(":", first + 1);
  if (second <= first + 1) {
    return null;
  }
  const matchPath = line.slice(0, first);
  const lineNumberRaw = line.slice(first + 1, second);
  const preview = line.slice(second + 1);
  const lineNumber = Number.parseInt(lineNumberRaw, 10);
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
    return null;
  }
  return {
    path: matchPath,
    line: lineNumber,
    column: 1,
    preview
  };
}

async function resolveGitRoot(workspaceDir: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", workspaceDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8"
    });
    const gitRoot = toText(result.stdout).trim();
    if (!gitRoot) {
      throw new Error("Unable to resolve git root");
    }
    return path.resolve(gitRoot);
  } catch {
    throw new Error("Workspace is not inside a git repository");
  }
}

async function resolveGitHead(gitRoot: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", gitRoot, "rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  const head = toText(result.stdout).trim();
  if (!head) {
    throw new Error("Unable to resolve git HEAD");
  }
  return head;
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const canonicalRepoRoot = canonicalizePath(repoRoot);
  const canonicalAbsolutePath = canonicalizePath(absolutePath);
  if (!isWithinRoot(canonicalAbsolutePath, canonicalRepoRoot)) {
    throw new Error(`Path is outside git repository root: ${absolutePath}`);
  }
  const relative = path.relative(canonicalRepoRoot, canonicalAbsolutePath);
  return relative.length > 0 ? normalizePosixPath(relative) : ".";
}

function resolveScopedGitPaths(params: {
  repoRoot: string;
  workspaceDir: string;
  mutableRoots: string[];
  inputPaths?: string[];
}): string[] {
  if (params.inputPaths && params.inputPaths.length > 0) {
    const resolved = new Set<string>();
    for (const requested of params.inputPaths) {
      const absolute = resolveWorkspaceRelativeOrAbsolutePath(params.workspaceDir, requested);
      resolved.add(toRepoRelativePath(params.repoRoot, absolute));
    }
    return Array.from(resolved).sort((left, right) => left.localeCompare(right));
  }

  // No mutable-root scoping: default to whole repository.
  return ["."];
}

function parseNumstat(output: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const add = Number.parseInt(parts[0] ?? "0", 10);
    const rem = Number.parseInt(parts[1] ?? "0", 10);
    if (Number.isFinite(add)) {
      added += add;
    }
    if (Number.isFinite(rem)) {
      removed += rem;
    }
  }
  return { added, removed };
}

function parsePatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      const left = diffMatch[1]?.trim();
      const right = diffMatch[2]?.trim();
      if (left && left !== "/dev/null") {
        paths.add(left);
      }
      if (right && right !== "/dev/null") {
        paths.add(right);
      }
      continue;
    }

    const plusMatch = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusMatch) {
      const candidate = plusMatch[1]?.trim();
      if (candidate && candidate !== "/dev/null") {
        paths.add(candidate);
      }
      continue;
    }

    const minusMatch = line.match(/^--- (?:a\/)?(.+)$/);
    if (minusMatch) {
      const candidate = minusMatch[1]?.trim();
      if (candidate && candidate !== "/dev/null") {
        paths.add(candidate);
      }
    }
  }
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
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
      ? entry.highlights.find(
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

async function collectToolFiles(dirPath: string): Promise<string[]> {
  const discovered: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!CUSTOM_TOOL_EXTENSIONS.has(extension)) {
        continue;
      }
      discovered.push(absolute);
    }
  }

  await walk(dirPath);
  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

async function importToolFile(filePath: string): Promise<ToolDefinition | null> {
  const extension = path.extname(filePath).toLowerCase();
  const imported =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? await importTypeScriptModule(filePath)
      : await import(pathToFileURL(filePath).href);
  const importedRecord = imported && typeof imported === "object" ? (imported as Record<string, unknown>) : undefined;
  const candidate = importedRecord?.tool ?? importedRecord?.default ?? imported;
  const direct = asToolDefinition(unwrapModuleDefault(candidate));
  if (direct) {
    return direct;
  }
  return null;
}

export async function buildToolRegistry(params: {
  builtInTools: ToolDefinition[];
  customToolsDirectory: string;
}): Promise<ToolRegistryResult> {
  const tools = new Map<string, ToolDefinition>();
  const diagnostics: ToolRegistryDiagnostics = {
    loadedBuiltInCount: 0,
    loadedCustomCount: 0,
    skipped: []
  };

  for (const tool of params.builtInTools) {
    const normalized = asToolDefinition(tool);
    if (!normalized) {
      continue;
    }
    tools.set(normalized.name, normalized);
    diagnostics.loadedBuiltInCount += 1;
  }

  const builtInNames = new Set(tools.keys());
  const customFiles = await collectToolFiles(params.customToolsDirectory);

  for (const filePath of customFiles) {
    let customTool: ToolDefinition | null = null;
    try {
      customTool = await importToolFile(filePath);
    } catch (error) {
      diagnostics.skipped.push({
        filePath,
        reason: "import_error",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    if (!customTool) {
      diagnostics.skipped.push({
        filePath,
        reason: "invalid_shape",
        message: "Expected a tool definition export with name, execute, and optional parameters schema"
      });
      continue;
    }

    if (builtInNames.has(customTool.name)) {
      diagnostics.skipped.push({
        filePath,
        reason: "name_collision",
        message: `Tool name \"${customTool.name}\" is reserved by a built-in tool`,
        toolName: customTool.name
      });
      continue;
    }

    if (tools.has(customTool.name)) {
      diagnostics.skipped.push({
        filePath,
        reason: "duplicate_custom_name",
        message: `Tool name \"${customTool.name}\" is already loaded from another custom tool file`,
        toolName: customTool.name
      });
      continue;
    }

    tools.set(customTool.name, customTool);
    diagnostics.loadedCustomCount += 1;
  }

  return { tools, diagnostics };
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
        const resolved = resolveWorkspacePath(context.workspaceDir, input.path);
        const content = await fs.readFile(resolved.absolute, input.encoding);
        return {
          action: input.action,
          path: resolved.relative,
          content
        };
      }

      if (input.action === "write") {
        const resolved = resolveWorkspacePath(context.workspaceDir, input.path);
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
        const resolved = resolveWorkspacePath(context.workspaceDir, input.path);
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

      const resolved = resolveWorkspacePath(context.workspaceDir, input.path);
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

  const codeSearchTool = defineTool({
    name: "code.search",
    description: "Search code across the workspace/repository",
    parameters: codeSearchToolSchema,
    execute: async (rawInput, context) => {
      const input = codeSearchToolSchema.parse(rawInput);
      let searchRoot = context.workspaceDir;
      try {
        searchRoot = await resolveGitRoot(context.workspaceDir);
      } catch {
        // best effort: non-git workspace falls back to configured workspace dir
      }
      const searchRoots: string[] = [];
      for (const root of [searchRoot]) {
        try {
          const stat = await fs.stat(root);
          if (stat.isDirectory() || stat.isFile()) {
            searchRoots.push(root);
          }
        } catch {
          // ignore missing roots
        }
      }

      if (searchRoots.length === 0) {
        return {
          query: input.query,
          matches: [],
          truncated: false
        };
      }

      const includeGlobs = (input.globInclude ?? []).map((glob) => glob.trim()).filter((glob) => glob.length > 0);
      const excludeGlobs = (input.globExclude ?? []).map((glob) => glob.trim()).filter((glob) => glob.length > 0);
      const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
      let truncated = false;

      const appendMatch = (entry: { path: string; line: number; column: number; preview: string }): void => {
        const absolutePath = path.isAbsolute(entry.path)
          ? path.resolve(entry.path)
          : path.resolve(context.workspaceDir, entry.path);
        if (matches.length >= input.maxResults) {
          truncated = true;
          return;
        }
        matches.push({
          path: workspaceRelativePath(context.workspaceDir, absolutePath),
          line: entry.line,
          column: entry.column,
          preview: entry.preview
        });
      };

      let provider = "ripgrep";
      try {
        const rgArgs = ["--json", "--line-number", "--column", "--no-heading"];
        if (input.literal) {
          rgArgs.push("--fixed-strings");
        }
        for (const glob of includeGlobs) {
          rgArgs.push("--glob", glob);
        }
        for (const glob of excludeGlobs) {
          rgArgs.push("--glob", `!${glob}`);
        }
        rgArgs.push(input.query, ...searchRoots);

        let output = "";
        try {
          const rgResult = await execFileAsync("rg", rgArgs, {
            cwd: context.workspaceDir,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024
          });
          output = toText(rgResult.stdout);
        } catch (error) {
          const execError = error as Error & {
            code?: number | string;
            stdout?: string | Buffer;
          };
          if (execError.code === "ENOENT") {
            throw error;
          }
          if (execError.code === 1) {
            output = toText(execError.stdout);
          } else {
            throw new Error(execError.message);
          }
        }

        for (const line of output.split(/\r?\n/)) {
          if (matches.length >= input.maxResults) {
            truncated = true;
            break;
          }
          const parsed = parseRipgrepLine(line);
          if (!parsed) {
            continue;
          }
          appendMatch(parsed);
        }
      } catch (error) {
        const execError = error as Error & {
          code?: number | string;
          stdout?: string | Buffer;
        };
        if (execError.code !== "ENOENT") {
          throw new Error(`code.search failed: ${execError.message}`);
        }

        provider = "grep-fallback";
        const grepArgs = ["-RIn", "--binary-files=without-match"];
        if (input.literal) {
          grepArgs.push("-F");
        }
        grepArgs.push(input.query, ...searchRoots);

        let output = "";
        try {
          const grepResult = await execFileAsync("grep", grepArgs, {
            cwd: context.workspaceDir,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024
          });
          output = toText(grepResult.stdout);
        } catch (grepError) {
          const grepExecError = grepError as Error & {
            code?: number | string;
            stdout?: string | Buffer;
          };
          if (grepExecError.code === 1) {
            output = toText(grepExecError.stdout);
          } else {
            throw new Error(`code.search failed: ${grepExecError.message}`);
          }
        }

        for (const line of output.split(/\r?\n/)) {
          if (matches.length >= input.maxResults) {
            truncated = true;
            break;
          }
          const parsed = parseGrepLine(line);
          if (!parsed) {
            continue;
          }
          appendMatch(parsed);
        }
      }

      return {
        query: input.query,
        matches,
        truncated,
        provider
      };
    }
  });

  const codeReadContextTool = defineTool({
    name: "code.read_context",
    description: "Read a focused line window from a code file",
    parameters: codeReadContextToolSchema,
    execute: async (rawInput, context) => {
      const input = codeReadContextToolSchema.parse(rawInput);
      const resolved = resolveMutableFilePath(context, input.path);
      const content = await fs.readFile(resolved.absolute, "utf8");
      const lines = content.split(/\r?\n/);

      let anchorLine = input.line;
      if (anchorLine === undefined && input.anchor !== undefined) {
        let seen = 0;
        if (input.anchorMode === "regex") {
          let regex: RegExp;
          try {
            regex = new RegExp(input.anchor, "u");
          } catch (error) {
            throw new Error(`Invalid anchor regex: ${error instanceof Error ? error.message : String(error)}`);
          }
          for (let index = 0; index < lines.length; index += 1) {
            if (regex.test(lines[index] ?? "")) {
              seen += 1;
              if (seen === input.occurrence) {
                anchorLine = index + 1;
                break;
              }
            }
          }
        } else {
          for (let index = 0; index < lines.length; index += 1) {
            if ((lines[index] ?? "").includes(input.anchor)) {
              seen += 1;
              if (seen === input.occurrence) {
                anchorLine = index + 1;
                break;
              }
            }
          }
        }

        if (anchorLine === undefined) {
          throw new Error(`Anchor not found in file: ${input.anchor}`);
        }
      }

      if (anchorLine === undefined) {
        throw new Error("line or anchor is required");
      }
      if (anchorLine > lines.length) {
        throw new Error(`Line out of range: ${anchorLine} > ${lines.length}`);
      }

      const startLine = Math.max(1, anchorLine - input.before);
      const endLine = Math.min(lines.length, anchorLine + input.after);
      const snippet: Array<{ line: number; text: string }> = [];
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        snippet.push({
          line: lineNumber,
          text: lines[lineNumber - 1] ?? ""
        });
      }

      return {
        path: resolved.path,
        anchorLine,
        startLine,
        endLine,
        lines: snippet
      };
    }
  });

  const codeStatusTool = defineTool({
    name: "code.status",
    description: "Show git status summary",
    parameters: codeStatusToolSchema,
    execute: async (rawInput, context) => {
      const input = codeStatusToolSchema.parse(rawInput);
      const gitRoot = await resolveGitRoot(context.workspaceDir);
      const statusResult = await execFileAsync("git", ["-C", gitRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024
      });
      const entries: Array<{ path: string; status: string; repoPath: string }> = [];
      for (const line of toText(statusResult.stdout).split(/\r?\n/)) {
        if (!line.trim() || line.length < 4) {
          continue;
        }
        const status = line.slice(0, 2).trim() || "??";
        const rawPath = line.slice(3).trim();
        const normalizedPath = rawPath.includes(" -> ") ? (rawPath.split(" -> ").pop() ?? "").trim() : rawPath;
        if (!normalizedPath) {
          continue;
        }

        const absolute = path.resolve(gitRoot, normalizedPath);
        entries.push({
          path: workspaceRelativePath(context.workspaceDir, absolute),
          status,
          repoPath: toRepoRelativePath(gitRoot, absolute)
        });
      }

      const repoPaths = entries.map((entry) => entry.repoPath);
      let added = 0;
      let removed = 0;
      if (repoPaths.length > 0) {
        const unstaged = await execFileAsync("git", ["-C", gitRoot, "diff", "--numstat", "--", ...repoPaths], {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024
        });
        const staged = await execFileAsync("git", ["-C", gitRoot, "diff", "--cached", "--numstat", "--", ...repoPaths], {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024
        });
        const unstagedStats = parseNumstat(toText(unstaged.stdout));
        const stagedStats = parseNumstat(toText(staged.stdout));
        added = unstagedStats.added + stagedStats.added;
        removed = unstagedStats.removed + stagedStats.removed;
      }

      return {
        scope: input.scope,
        summary: {
          changedFiles: entries.length,
          added,
          removed
        },
        files: entries.map((entry) => ({
          path: entry.path,
          status: entry.status
        }))
      };
    }
  });

  const codeDiffTool = defineTool({
    name: "code.diff",
    description: "Show unified git diff",
    parameters: codeDiffToolSchema,
    execute: async (rawInput, context) => {
      const input = codeDiffToolSchema.parse(rawInput);
      if (input.mode === "between_revisions" && !input.from) {
        throw new Error("code.diff mode=between_revisions requires `from`");
      }

      const gitRoot = await resolveGitRoot(context.workspaceDir);
      const scopedPaths = resolveScopedGitPaths({
        repoRoot: gitRoot,
        workspaceDir: context.workspaceDir,
        mutableRoots: context.mutableRoots,
        inputPaths: input.paths
      });

      if (scopedPaths.length === 0) {
        return {
          mode: input.mode,
          from: input.from ?? null,
          to: input.to ?? null,
          paths: [],
          diff: "",
          truncated: false
        };
      }

      const args = ["-C", gitRoot, "diff"];
      if (input.mode === "between_revisions") {
        args.push(input.from!, input.to ?? "HEAD");
      }
      args.push("--", ...scopedPaths);
      const diffResult = await execFileAsync("git", args, {
        encoding: "utf8",
        maxBuffer: Math.max(1024 * 1024, input.maxBytes * 4)
      });
      const diffText = toText(diffResult.stdout);
      const truncated = Buffer.byteLength(diffText, "utf8") > input.maxBytes;
      const body = truncated
        ? Buffer.from(diffText, "utf8").subarray(0, input.maxBytes).toString("utf8")
        : diffText;

      return {
        mode: input.mode,
        from: input.from ?? null,
        to: input.to ?? null,
        paths: scopedPaths,
        diff: body,
        truncated
      };
    }
  });

  const codePatchTool = defineTool({
    name: "code.patch",
    description: "Apply a unified diff patch",
    parameters: codePatchToolSchema,
    execute: async (rawInput, context) => {
      const input = codePatchToolSchema.parse(rawInput);
      const gitRoot = await resolveGitRoot(context.workspaceDir);
      if (input.expectedBase?.kind === "git_head") {
        const currentHead = await resolveGitHead(gitRoot);
        if (currentHead !== input.expectedBase.value.trim()) {
          throw new Error(
            `stale_revision: expected git HEAD ${input.expectedBase.value.trim()} but found ${currentHead}`
          );
        }
      }
      const patchPaths = parsePatchPaths(input.patch);
      if (patchPaths.length === 0) {
        throw new Error("Patch payload does not include any file paths");
      }

      const normalizedPaths: string[] = [];
      for (const patchPath of patchPaths) {
        const absolute = path.resolve(gitRoot, patchPath);
        normalizedPaths.push(workspaceRelativePath(context.workspaceDir, absolute));
      }

      const patchFilePath = path.join(
        os.tmpdir(),
        `drost-code-patch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.diff`
      );
      await fs.writeFile(patchFilePath, input.patch, "utf8");
      try {
        const args = ["-C", gitRoot, "apply", "--whitespace=nowarn"];
        if (input.dryRun) {
          args.push("--check");
        }
        args.push(patchFilePath);
        await execFileAsync("git", args, {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
      } catch (error) {
        const execError = error as Error & {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        const stderr = toText(execError.stderr).trim();
        const stdout = toText(execError.stdout).trim();
        const diagnostics = [stderr, stdout]
          .filter((value) => value.length > 0)
          .join(" | ");
        throw new Error(`patch_rejected: ${diagnostics || execError.message}`);
      } finally {
        try {
          await fs.rm(patchFilePath, { force: true });
        } catch {
          // best effort cleanup
        }
      }

      return {
        dryRun: input.dryRun,
        paths: normalizedPaths,
        applied: !input.dryRun
      };
    }
  });

  const shellTool = defineTool({
    name: "shell",
    description: "Run a shell command",
    parameters: shellToolSchema,
    execute: async (rawInput, context) => {
      const input = shellToolSchema.parse(rawInput);
      const timeoutMs = input.timeoutMs ?? params.shellPolicy?.timeoutMs;
      const maxBuffer = params.shellPolicy?.maxBufferBytes ?? 512 * 1024;
      const cwd = input.cwd
        ? resolveWorkspacePath(context.workspaceDir, input.cwd).absolute
        : context.workspaceDir;

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

  return [fileTool, codeSearchTool, codeReadContextTool, codeStatusTool, codeDiffTool, codePatchTool, shellTool, webTool, agentTool];
}
