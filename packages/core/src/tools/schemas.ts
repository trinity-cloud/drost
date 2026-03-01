import { z } from "zod";

const DEFAULT_MAX_WEB_BODY_BYTES = 120_000;

export const fileToolSchema = z.discriminatedUnion("action", [
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

export const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional()
});

export const webToolSchema = z.discriminatedUnion("action", [
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

export const agentToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status")
  }),
  z.object({
    action: z.literal("restart"),
    reason: z.string().optional()
  })
]);

export const subagentStartToolSchema = z.object({
  sessionId: z.string().min(1).optional(),
  input: z.string().min(1),
  providerId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const subagentPollToolSchema = z.object({
  jobId: z.string().min(1)
});

export const subagentListToolSchema = z.object({
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional().default(50)
});

export const subagentCancelToolSchema = z.object({
  jobId: z.string().min(1)
});

export const subagentLogToolSchema = z.object({
  jobId: z.string().min(1),
  limit: z.number().int().positive().max(1000).optional().default(200)
});

export const codeSearchToolSchema = z.object({
  query: z.string().min(1),
  globInclude: z.array(z.string().min(1)).optional(),
  globExclude: z.array(z.string().min(1)).optional(),
  maxResults: z.number().int().positive().max(500).optional().default(50),
  literal: z.boolean().optional().default(false)
});

export const codeReadContextToolSchema = z
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

export const codeStatusToolSchema = z.object({
  scope: z.enum(["mutable_roots", "workspace"]).optional().default("mutable_roots")
});

export const codeDiffToolSchema = z.object({
  mode: z.enum(["worktree_vs_head", "between_revisions"]).optional().default("worktree_vs_head"),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  maxBytes: z.number().int().positive().max(2_000_000).optional().default(200_000)
});

export const codePatchToolSchema = z.object({
  patch: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
  expectedBase: z
    .object({
      kind: z.literal("git_head"),
      value: z.string().min(1)
    })
    .optional()
});
