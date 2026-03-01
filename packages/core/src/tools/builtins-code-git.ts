import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertPathInMutableRoots,
  canonicalizePath,
  isWithinRoot
} from "../path-policy.js";
import { defineTool } from "./definition.js";
import { codeDiffToolSchema, codePatchToolSchema, codeStatusToolSchema } from "./schemas.js";
import type { ToolDefinition } from "./types.js";

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

function resolveWorkspaceRelativeOrAbsolutePath(workspaceDir: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceDir, requestedPath);
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
      assertPathInMutableRoots({
        targetPath: absolute,
        mutableRoots: params.mutableRoots,
        requestedPath: requested
      });
      resolved.add(toRepoRelativePath(params.repoRoot, absolute));
    }
    return Array.from(resolved).sort((left, right) => left.localeCompare(right));
  }

  const resolved = new Set<string>();
  for (const mutableRoot of params.mutableRoots) {
    try {
      const absolute = path.isAbsolute(mutableRoot)
        ? path.resolve(mutableRoot)
        : path.resolve(params.workspaceDir, mutableRoot);
      if (!isWithinRoot(absolute, params.repoRoot)) {
        continue;
      }
      resolved.add(toRepoRelativePath(params.repoRoot, absolute));
    } catch {
      // ignore invalid mutable roots
    }
  }

  if (resolved.size === 0) {
    const workspacePath = path.resolve(params.workspaceDir);
    if (isWithinRoot(workspacePath, params.repoRoot)) {
      resolved.add(toRepoRelativePath(params.repoRoot, workspacePath));
    }
  }

  return Array.from(resolved).sort((left, right) => left.localeCompare(right));
}

function isPathInMutableRoots(targetPath: string, mutableRoots: string[]): boolean {
  return mutableRoots.some((root) => isWithinRoot(targetPath, root));
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

export function createCodeGitTools(): ToolDefinition[] {
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
        if (!isPathInMutableRoots(absolute, context.mutableRoots)) {
          continue;
        }
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
        assertPathInMutableRoots({
          targetPath: absolute,
          mutableRoots: context.mutableRoots,
          requestedPath: patchPath
        });
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

  return [codeStatusTool, codeDiffTool, codePatchTool];
}
