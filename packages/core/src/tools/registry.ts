import { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importTypeScriptModule, unwrapModuleDefault } from "../module-loader.js";
import { asToolDefinition } from "./definition.js";
import type {
  ToolDefinition,
  ToolRegistryDiagnostics,
  ToolRegistryResult
} from "./types.js";

const CUSTOM_TOOL_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

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
