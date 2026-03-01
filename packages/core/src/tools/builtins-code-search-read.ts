import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertPathInMutableRoots,
  canonicalizePath,
  isWithinRoot
} from "../path-policy.js";
import { defineTool } from "./definition.js";
import { codeReadContextToolSchema, codeSearchToolSchema } from "./schemas.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

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
  assertPathInMutableRoots({
    targetPath: absolute,
    mutableRoots: context.mutableRoots,
    requestedPath
  });
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

export function createCodeSearchAndReadTools(): ToolDefinition[] {
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
      const candidateRoots = context.mutableRoots.length > 0 ? context.mutableRoots : [context.workspaceDir];
      for (const root of candidateRoots) {
        const absoluteRoot = path.isAbsolute(root) ? root : path.resolve(context.workspaceDir, root);
        if (!isWithinRoot(absoluteRoot, searchRoot)) {
          continue;
        }
        try {
          const stat = await fs.stat(absoluteRoot);
          if (stat.isDirectory() || stat.isFile()) {
            searchRoots.push(absoluteRoot);
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

  return [codeSearchTool, codeReadContextTool];
}
