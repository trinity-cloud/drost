import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../../packages/core/dist/index.js";

class EchoAdapter {
  constructor() {
    this.id = "observability-schema-smoke-adapter";
  }

  async probe(profile) {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request) {
    const input =
      request.messages
        .filter((entry) => entry.role === "user")
        .at(-1)?.content ?? "";
    const text = `echo:${input}`;
    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text
      }
    });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[observability-schema-smoke] ${message}`);
  }
}

function parseJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function validateEntrySchema(entry, stream) {
  assert(entry && typeof entry === "object", `entry must be object stream=${stream}`);
  assert(typeof entry.timestamp === "string", `missing timestamp stream=${stream}`);
  assert(Number.isFinite(Date.parse(entry.timestamp)), `invalid timestamp stream=${stream}`);
  assert(entry.stream === stream, `entry stream mismatch expected=${stream} got=${String(entry.stream)}`);
  assert("payload" in entry, `missing payload stream=${stream}`);
}

async function run() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-observability-schema-smoke-"));
  const observabilityDir = path.join(workspaceDir, ".drost", "observability");
  const rawSecret = "sk-schema-sensitive-1234567890";

  const gateway = createGateway({
    workspaceDir,
    observability: {
      enabled: true,
      directory: observabilityDir
    },
    providers: {
      defaultSessionProvider: "echo",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "echo",
          adapterId: "observability-schema-smoke-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:echo"
        }
      ],
      adapters: [new EchoAdapter()]
    }
  });

  await gateway.start();
  try {
    gateway.ensureSession("schema");
    await gateway.runTool({
      sessionId: "schema",
      toolName: "file",
      input: {
        action: "write",
        path: "schema.txt",
        content: `secret=${rawSecret}`,
        token: rawSecret
      }
    });
    await gateway.runSessionTurn({
      sessionId: "schema",
      input: `validate observability schema api_key=${rawSecret}`,
      onEvent: () => undefined
    });
  } finally {
    await gateway.stop();
  }

  const runtimePath = path.join(observabilityDir, "runtime-events.jsonl");
  const toolPath = path.join(observabilityDir, "tool-traces.jsonl");
  const usagePath = path.join(observabilityDir, "usage-events.jsonl");

  for (const filePath of [runtimePath, toolPath, usagePath]) {
    assert(fs.existsSync(filePath), `missing observability file ${filePath}`);
  }

  const runtimeEntries = parseJsonl(runtimePath);
  const toolEntries = parseJsonl(toolPath);
  const usageEntries = parseJsonl(usagePath);
  assert(runtimeEntries.length > 0, "runtime-events is empty");
  assert(toolEntries.length > 0, "tool-traces is empty");
  assert(usageEntries.length > 0, "usage-events is empty");

  for (const entry of runtimeEntries) {
    validateEntrySchema(entry, "runtime-events");
  }
  for (const entry of toolEntries) {
    validateEntrySchema(entry, "tool-traces");
  }
  for (const entry of usageEntries) {
    validateEntrySchema(entry, "usage-events");
  }

  const combinedText = [runtimePath, toolPath, usagePath]
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert(!combinedText.includes(rawSecret), "raw secret leaked into observability payload");

  process.stdout.write(`[observability-schema-smoke] ok workspace=${workspaceDir}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
