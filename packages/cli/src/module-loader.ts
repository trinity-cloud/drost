import { pathToFileURL } from "node:url";

const MAX_UNWRAP_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function unwrapModuleDefault(value: unknown): unknown {
  let current = value;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      break;
    }
    if (!("default" in current)) {
      break;
    }

    const keys = Object.keys(current);
    const defaultOnly = keys.length === 1 && keys[0] === "default";
    const defaultWithEsModule =
      keys.length === 2 && keys.includes("default") && keys.includes("__esModule");
    if (!defaultOnly && !defaultWithEsModule) {
      break;
    }

    const next = current.default;
    if (next === undefined || next === current) {
      break;
    }
    current = next;
  }

  return current;
}

export async function importTypeScriptModule(filePath: string): Promise<unknown> {
  const { tsImport } = await import("tsx/esm/api");
  const moduleUrl = pathToFileURL(filePath).href;
  return await tsImport(moduleUrl, {
    parentURL: moduleUrl
  });
}
