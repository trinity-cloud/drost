import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../../packages/core/dist/index.js";

class EchoAdapter {
  constructor() {
    this.id = "smoke-echo-adapter";
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
    const lastUser =
      request.messages
        .filter((entry) => entry.role === "user")
        .at(-1)?.content ?? "";
    const text = `echo:${lastUser}`;
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
    throw new Error(`[control-api-smoke] ${message}`);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON. status=${response.status} body=${text}`);
  }
}

async function run() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-control-smoke-"));
  const observabilityDir = path.join(workspaceDir, ".drost", "observability");

  const gateway = createGateway({
    workspaceDir,
    controlApi: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      token: "admin-smoke-token",
      readToken: "read-smoke-token",
      allowLoopbackWithoutAuth: false,
      mutationRateLimitPerMinute: 30
    },
    observability: {
      enabled: true,
      directory: observabilityDir
    },
    providers: {
      defaultSessionProvider: "smoke-primary",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "smoke-primary",
          adapterId: "smoke-echo-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:smoke-primary"
        },
        {
          id: "smoke-fallback",
          adapterId: "smoke-echo-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:smoke-fallback"
        }
      ],
      adapters: [new EchoAdapter()]
    },
    providerRouter: {
      enabled: true,
      defaultRoute: "smoke-default",
      routes: [
        {
          id: "smoke-default",
          primaryProviderId: "smoke-primary",
          fallbackProviderIds: ["smoke-fallback"]
        }
      ]
    },
    failover: {
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 0
    },
    sessionStore: {
      enabled: true,
      retention: {
        enabled: true,
        maxSessions: 100,
        archiveFirst: false
      }
    }
  });

  await gateway.start();
  try {
    const controlUrl = gateway.getStatus().controlUrl;
    assert(controlUrl, "missing controlUrl after gateway start");

    const unauthorized = await fetch(`${controlUrl}/status`);
    assert(unauthorized.status === 401, `expected 401 for unauthorized status, got ${unauthorized.status}`);

    const statusResponse = await fetch(`${controlUrl}/status`, {
      headers: {
        authorization: "Bearer read-smoke-token"
      }
    });
    assert(statusResponse.status === 200, `expected 200 for status, got ${statusResponse.status}`);
    const statusPayload = await readJson(statusResponse);
    assert(statusPayload.ok === true, "status payload not ok=true");

    const createdResponse = await fetch(`${controlUrl}/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-smoke-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        channel: "local",
        providerRouteId: "smoke-default"
      })
    });
    assert(createdResponse.status === 200, `expected 200 create session, got ${createdResponse.status}`);
    const createdPayload = await readJson(createdResponse);
    assert(typeof createdPayload.sessionId === "string", "create session returned invalid sessionId");

    const chatResponse = await fetch(`${controlUrl}/chat/send`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-smoke-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: createdPayload.sessionId,
        input: "control smoke"
      })
    });
    assert(chatResponse.status === 200, `expected 200 chat send, got ${chatResponse.status}`);
    const chatPayload = await readJson(chatResponse);
    assert(String(chatPayload.response || "").includes("echo:control smoke"), "chat response missing expected output");

    const lanesResponse = await fetch(`${controlUrl}/orchestration/lanes`, {
      headers: {
        authorization: "Bearer read-smoke-token"
      }
    });
    assert(lanesResponse.status === 200, `expected 200 orchestration lanes, got ${lanesResponse.status}`);

    const retentionResponse = await fetch(`${controlUrl}/sessions/retention`, {
      headers: {
        authorization: "Bearer read-smoke-token"
      }
    });
    assert(retentionResponse.status === 200, `expected 200 retention status, got ${retentionResponse.status}`);

    const pruneResponse = await fetch(`${controlUrl}/sessions/prune`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-smoke-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        dryRun: true,
        policy: {
          enabled: true,
          maxSessions: 1,
          archiveFirst: false
        }
      })
    });
    assert(pruneResponse.status === 200, `expected 200 prune dry-run, got ${pruneResponse.status}`);

    const eventsResponse = await fetch(`${controlUrl}/events`, {
      headers: {
        authorization: "Bearer read-smoke-token"
      }
    });
    assert(eventsResponse.status === 200, `expected 200 events stream, got ${eventsResponse.status}`);
    const reader = eventsResponse.body?.getReader();
    assert(reader, "events response missing readable body");
    const firstChunk = await reader.read();
    assert(Boolean(firstChunk.value && firstChunk.value.length > 0), "events stream did not return initial chunk");
    await reader.cancel();
  } finally {
    await gateway.stop();
  }

  assert(fs.existsSync(path.join(observabilityDir, "runtime-events.jsonl")), "missing runtime events observability file");
  process.stdout.write(`[control-api-smoke] ok workspace=${workspaceDir}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
