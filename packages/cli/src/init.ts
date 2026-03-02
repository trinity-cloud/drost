import fs from "node:fs";
import path from "node:path";

const PROJECT_DIRS = [
  "agent",
  "runtime",
  "runtime/kernel",
  "workspace/.drost/tools",
  ".drost"
] as const;

function templateConfig(): string {
  return `export default {
  workspaceDir: "./workspace",
  runtime: {
    entry: "./runtime/index.ts"
  },
  agent: {
    entry: "./agent/index.ts"
  },
  evolution: {
    enabled: true,
    mutableRoots: ["./agent", "./runtime", "./workspace"],
    validation: {
      commands: ["pnpm -r --if-present build", "pnpm test"]
    },
    healthGate: {
      enabled: true,
      timeoutMs: 15000
    },
    rollbackOnFailure: true,
    strictMode: true
  },
  sessionStore: {
    enabled: true,
    directory: "./workspace/sessions"
  },
  health: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/healthz"
  },
  providers: {
    defaultSessionProvider: "openai-codex",
    startupProbe: {
      enabled: true,
      timeoutMs: 20000
    },
    profiles: [
      {
        id: "openai-codex",
        adapterId: "codex-exec",
        kind: "openai-codex",
        family: "codex",
        baseUrl: "https://api.openai.com",
        model: "auto",
        authProfileId: "openai-codex:default"
      },
      {
        id: "openai",
        adapterId: "openai-responses",
        kind: "openai",
        family: "openai-responses",
        baseUrl: "https://api.openai.com",
        model: "gpt-4.1-mini",
        authProfileId: "openai:default"
      },
      {
        id: "anthropic",
        adapterId: "anthropic-messages",
        kind: "anthropic",
        family: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-5",
        authProfileId: "anthropic:default"
      },
      {
        id: "local-openai-compatible",
        adapterId: "openai-responses",
        kind: "openai-compatible",
        family: "openai-responses",
        baseUrl: "http://localhost:8000",
        model: "your-model-id",
        authProfileId: "openai-compatible:local"
      }
    ]
  }
};
`;
}

function templateTool(): string {
  return [
    "export default {",
    "  name: \"hello_tool\",",
    "  description: \"Simple example custom tool\",",
    "  execute: async (input) => ({",
    "    ok: true,",
    "    received: input",
    "  })",
    "};",
    ""
  ].join("\n");
}

function templateAgentModule(): string {
  return [
    "export default {",
    "  name: \"my-agent\",",
    "  description: \"Project-local mutable agent module\",",
    "  hooks: {",
    "    beforeTurn: async ({ input }) => ({",
    "      input",
    "    })",
    "  }",
    "};",
    ""
  ].join("\n");
}

function templateAgentReadme(): string {
  return [
    "# Agent Module",
    "",
    "This folder is the mutable code layer for this agent project.",
    "",
    "- Edit `index.ts` to customize behavior per-agent.",
    "- Runtime behavior orchestration lives in `../runtime`.",
    "- Self-evolution policies should limit writes to `agent/`, `runtime/`, and `workspace/` roots."
  ].join("\n");
}

function templateRuntimeModule(): string {
  return [
    "import { startProjectRuntime } from \"./kernel/start-loop\";",
    "",
    "export default {",
    "  async start(params) {",
    "    return await startProjectRuntime(params);",
    "  }",
    "};",
    ""
  ].join("\n");
}

function templateRuntimeKernelStartLoop(): string {
  return [
    "import { applyRuntimePolicy } from \"./policy\";",
    "",
    "export async function startProjectRuntime(params) {",
    "  const runtimeConfig = applyRuntimePolicy(params.config);",
    "  // Local kernel orchestration entrypoint.",
    "  // This is project-owned code and can diverge per agent.",
    "  return await params.runDefault({",
    "    config: runtimeConfig,",
    "    pidFilePath: params.pidFilePath,",
    "    uiMode: params.uiMode",
    "  });",
    "}",
    ""
  ].join("\n");
}

function templateRuntimeKernelPolicy(): string {
  return [
    "export function applyRuntimePolicy(config) {",
    "  // Kernel-level policy hook for this project runtime.",
    "  // Example: enforce health endpoint defaults if omitted.",
    "  return {",
    "    ...config,",
    "    health: {",
    "      enabled: true,",
    "      ...(config.health ?? {})",
    "    }",
    "  };",
    "}",
    ""
  ].join("\n");
}

function templateRuntimeReadme(): string {
  return [
    "# Runtime Module",
    "",
    "This folder is the project-owned runtime layer.",
    "",
    "- `index.ts` is executed by `drost start` for this project.",
    "- `kernel/start-loop.ts` is the local runtime orchestration path.",
    "- `kernel/policy.ts` is where runtime policy defaults can diverge per-agent.",
    "- Modify runtime behavior here without affecting other agents.",
    "- Keep self-evolution boundaries explicit in `drost.config.ts`."
  ].join("\n");
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureProjectDirectories(projectPath: string): void {
  for (const dir of PROJECT_DIRS) {
    ensureDirectory(path.join(projectPath, dir));
  }
}

function writeFileIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.writeFileSync(filePath, content);
  return true;
}

function scaffoldMissingFiles(projectPath: string): string[] {
  const written: string[] = [];

  const templates: Array<{ relativePath: string; content: string }> = [
    { relativePath: "drost.config.ts", content: templateConfig() },
    { relativePath: path.join("agent", "index.ts"), content: templateAgentModule() },
    { relativePath: path.join("agent", "README.md"), content: templateAgentReadme() },
    { relativePath: path.join("runtime", "index.ts"), content: templateRuntimeModule() },
    { relativePath: path.join("runtime", "README.md"), content: templateRuntimeReadme() },
    {
      relativePath: path.join("runtime", "kernel", "start-loop.ts"),
      content: templateRuntimeKernelStartLoop()
    },
    { relativePath: path.join("runtime", "kernel", "policy.ts"), content: templateRuntimeKernelPolicy() },
    { relativePath: path.join("workspace", ".drost", "tools", "hello.ts"), content: templateTool() }
  ];

  for (const template of templates) {
    const filePath = path.join(projectPath, template.relativePath);
    if (writeFileIfMissing(filePath, template.content)) {
      written.push(template.relativePath.replace(/\\/g, "/"));
    }
  }

  return written;
}

export interface MigrateRuntimeResult {
  projectPath: string;
  createdFiles: string[];
}

export function migrateProjectRuntime(projectRoot: string): MigrateRuntimeResult {
  const projectPath = path.resolve(projectRoot);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  ensureProjectDirectories(projectPath);
  const createdFiles = scaffoldMissingFiles(projectPath);
  return {
    projectPath,
    createdFiles
  };
}

export function initProject(targetName: string): { projectPath: string; created: boolean } {
  const projectPath = path.resolve(process.cwd(), targetName);
  if (fs.existsSync(projectPath)) {
    return { projectPath, created: false };
  }

  ensureDirectory(projectPath);
  ensureProjectDirectories(projectPath);
  scaffoldMissingFiles(projectPath);

  return { projectPath, created: true };
}
