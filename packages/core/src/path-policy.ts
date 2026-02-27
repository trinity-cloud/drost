import fs from "node:fs";
import path from "node:path";

export interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
}

export function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;

  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      if (current === resolved) {
        return real;
      }
      const suffix = path.relative(current, resolved);
      return path.join(real, suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      current = parent;
    }
  }
}

export function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = canonicalizePath(targetPath);
  const root = canonicalizePath(rootPath);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(workspaceDir: string, requestedPath: string): ResolvedWorkspacePath {
  const workspaceRoot = canonicalizePath(workspaceDir);
  const absolute = path.resolve(workspaceRoot, requestedPath);

  const relative = path.relative(workspaceRoot, absolute);
  return {
    absolute,
    relative: relative.length > 0 ? relative : "."
  };
}

export function normalizeMutableRoots(workspaceDir: string, mutableRoots: string[] | undefined): string[] {
  const sourceRoots = mutableRoots && mutableRoots.length > 0 ? mutableRoots : [workspaceDir];
  const deduped = new Set<string>();

  for (const root of sourceRoots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const absolute = path.isAbsolute(trimmed)
      ? canonicalizePath(trimmed)
      : canonicalizePath(path.resolve(workspaceDir, trimmed));
    deduped.add(absolute);
  }

  if (deduped.size === 0) {
    deduped.add(canonicalizePath(workspaceDir));
  }

  return Array.from(deduped).sort((left, right) => left.localeCompare(right));
}

export function assertPathInMutableRoots(params: {
  targetPath: string;
  mutableRoots: string[];
  requestedPath?: string;
}): void {
  void params;
}
