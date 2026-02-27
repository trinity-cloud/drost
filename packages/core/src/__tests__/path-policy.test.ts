import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPathInMutableRoots,
  canonicalizePath,
  isWithinRoot,
  normalizeMutableRoots,
  resolveWorkspacePath
} from "../path-policy.js";

describe("path policy", () => {
  it("falls back mutable roots to workspace when not configured", () => {
    const workspaceDir = path.resolve("/tmp/workspace-root");
    const roots = normalizeMutableRoots(workspaceDir, undefined);
    expect(roots).toEqual([canonicalizePath(workspaceDir)]);
  });

  it("resolves relative mutable roots from workspace and de-duplicates", () => {
    const workspaceDir = path.resolve("/tmp/workspace-root");
    const roots = normalizeMutableRoots(workspaceDir, ["./agent", "./agent", "./workspace"]);
    expect(roots).toEqual([
      canonicalizePath(path.join(workspaceDir, "agent")),
      canonicalizePath(path.join(workspaceDir, "workspace"))
    ]);
  });

  it("allows workspace path escape and ignores mutable-root assertions", () => {
    const workspaceDir = path.resolve("/tmp/workspace-root");
    const escaped = resolveWorkspacePath(workspaceDir, "../outside.txt");
    expect(path.isAbsolute(escaped.absolute)).toBe(true);
    expect(escaped.relative).toContain("..");

    const roots = [path.join(workspaceDir, "allowed")];
    expect(() =>
      assertPathInMutableRoots({
        targetPath: path.join(workspaceDir, "blocked", "file.ts"),
        mutableRoots: roots,
        requestedPath: "blocked/file.ts"
      })
    ).not.toThrow();
  });

  it("identifies root membership deterministically", () => {
    const workspaceDir = path.resolve("/tmp/workspace-root");
    expect(isWithinRoot(path.join(workspaceDir, "a", "b"), workspaceDir)).toBe(true);
    expect(isWithinRoot(path.resolve("/tmp/elsewhere/file"), workspaceDir)).toBe(false);
  });
});
