import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "@drost/core";

type ToolTemplateId = "basic" | "http" | "shell" | "file";

const TEMPLATES: Record<ToolTemplateId, (toolName: string) => string> = {
  basic: (toolName) =>
    [
      "export default {",
      `  name: \"${toolName}\",`,
      "  description: \"Basic custom tool\",",
      "  execute: async (input) => ({",
      "    ok: true,",
      "    input",
      "  })",
      "};",
      ""
    ].join("\n"),
  http: (toolName) =>
    [
      "export default {",
      `  name: \"${toolName}\",`,
      "  description: \"HTTP request helper tool\",",
      "  execute: async (input) => {",
      "    const url = typeof input === \"string\" ? input : String((input && input.url) || \"\");",
      "    if (!url) {",
      "      return { ok: false, error: \"url is required\" };",
      "    }",
      "    const response = await fetch(url);",
      "    const text = await response.text();",
      "    return { ok: response.ok, status: response.status, text };",
      "  }",
      "};",
      ""
    ].join("\n"),
  shell: (toolName) =>
    [
      "import { execFile } from \"node:child_process\";",
      "import { promisify } from \"node:util\";",
      "",
      "const execFileAsync = promisify(execFile);",
      "",
      "export default {",
      `  name: \"${toolName}\",`,
      "  description: \"Run a constrained shell command\",",
      "  execute: async (input) => {",
      "    const command = typeof input === \"string\" ? input : String((input && input.command) || \"\");",
      "    if (!command) {",
      "      return { ok: false, error: \"command is required\" };",
      "    }",
      "    const { stdout, stderr } = await execFileAsync(\"sh\", [\"-lc\", command]);",
      "    return { ok: true, stdout, stderr };",
      "  }",
      "};",
      ""
    ].join("\n"),
  file: (toolName) =>
    [
      "import fs from \"node:fs/promises\";",
      "import path from \"node:path\";",
      "",
      "export default {",
      `  name: \"${toolName}\",`,
      "  description: \"Read a file from workspace\",",
      "  execute: async (input, context) => {",
      "    const relativePath = typeof input === \"string\" ? input : String((input && input.path) || \"\");",
      "    if (!relativePath) {",
      "      return { ok: false, error: \"path is required\" };",
      "    }",
      "    const absolute = path.resolve(context.workspaceDir, relativePath);",
      "    const text = await fs.readFile(absolute, \"utf8\");",
      "    return { ok: true, text };",
      "  }",
      "};",
      ""
    ].join("\n")
};

function sanitizeName(rawName: string): string {
  return rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function resolveToolDir(config: GatewayConfig): string {
  if (config.toolDirectory) {
    return path.resolve(config.toolDirectory);
  }
  return path.resolve(config.workspaceDir, ".drost", "tools");
}

function usage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  drost tool list-templates",
      "  drost tool new <name> [--template <basic|http|shell|file>]"
    ].join("\n") + "\n"
  );
}

export function runToolCommand(args: string[], config: GatewayConfig): number {
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    usage();
    return 0;
  }

  if (command === "list-templates") {
    process.stdout.write(`Templates: ${Object.keys(TEMPLATES).join(", ")}\n`);
    return 0;
  }

  if (command !== "new") {
    usage();
    return 1;
  }

  const rawName = args[1];
  if (!rawName) {
    usage();
    return 1;
  }

  let template: ToolTemplateId = "basic";
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--template") {
      const candidate = args[i + 1] as ToolTemplateId | undefined;
      if (!candidate || !(candidate in TEMPLATES)) {
        process.stderr.write(`Unknown template: ${candidate ?? ""}\n`);
        return 1;
      }
      template = candidate;
      i += 1;
    }
  }

  const toolName = sanitizeName(rawName);
  if (!toolName) {
    process.stderr.write("Tool name must include at least one letter or number.\n");
    return 1;
  }

  const toolDir = resolveToolDir(config);
  fs.mkdirSync(toolDir, { recursive: true });
  const filePath = path.join(toolDir, `${toolName}.ts`);
  if (fs.existsSync(filePath)) {
    process.stderr.write(`Tool file already exists: ${filePath}\n`);
    return 1;
  }

  fs.writeFileSync(filePath, TEMPLATES[template](toolName), "utf8");
  process.stdout.write(`Created tool template: ${filePath}\n`);
  process.stdout.write("Run `drost restart` to load the new tool.\n");
  return 0;
}
