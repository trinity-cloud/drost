import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../../packages/core/dist/index.js";

const QUEUE_SUBMIT_P95_TARGET_MS = 5;
const CONTROL_READ_P95_TARGET_MS = 200;
const SSE_SUBSCRIBER_TARGET = 20;

class PerfAdapter {
  constructor() {
    this.id = "perf-smoke-adapter";
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
    if (input.startsWith("hold-")) {
      await new Promise((_, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (request.signal?.aborted) {
          onAbort();
          return;
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return;
    }
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
    throw new Error(`[performance-smoke] ${message}`);
  }
}

function p95(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

async function readWithTimeout(reader, timeoutMs, label) {
  return await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs))
  ]);
}

async function run() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drost-performance-smoke-"));

  const queueGateway = createGateway({
    workspaceDir,
    orchestration: {
      enabled: true,
      defaultMode: "queue",
      defaultCap: 1024,
      persistState: false
    },
    providers: {
      defaultSessionProvider: "echo",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "echo",
          adapterId: "perf-smoke-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:echo"
        }
      ],
      adapters: [new PerfAdapter()]
    }
  });

  await queueGateway.start();
  const pending = [];
  try {
    pending.push(
      queueGateway
        .runChannelTurn({
          identity: {
            channel: "telegram",
            workspaceId: "wk",
            chatId: "perf"
          },
          input: "hold-primary"
        })
        .catch(() => undefined)
    );

    const submitDurationsMs = [];
    for (let index = 0; index < 200; index += 1) {
      const started = process.hrtime.bigint();
      const turn = queueGateway
        .runChannelTurn({
          identity: {
            channel: "telegram",
            workspaceId: "wk",
            chatId: "perf"
          },
          input: `queued-${index}`
        })
        .catch(() => undefined);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      submitDurationsMs.push(elapsedMs);
      pending.push(turn);
    }

    const submitP95 = p95(submitDurationsMs);
    assert(
      submitP95 <= QUEUE_SUBMIT_P95_TARGET_MS,
      `queue submit p95 ${submitP95.toFixed(3)}ms exceeds ${QUEUE_SUBMIT_P95_TARGET_MS}ms`
    );
  } finally {
    await queueGateway.stop();
    await Promise.all(pending);
  }

  const controlGateway = createGateway({
    workspaceDir,
    controlApi: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      token: "perf-admin-token",
      readToken: "perf-read-token",
      allowLoopbackWithoutAuth: false
    },
    providers: {
      defaultSessionProvider: "echo",
      startupProbe: {
        enabled: false
      },
      profiles: [
        {
          id: "echo",
          adapterId: "perf-smoke-adapter",
          kind: "openai-compatible",
          model: "smoke",
          authProfileId: "auth:echo"
        }
      ],
      adapters: [new PerfAdapter()]
    }
  });

  await controlGateway.start();
  try {
    const controlUrl = controlGateway.getStatus().controlUrl;
    assert(controlUrl, "missing controlUrl");

    const readDurationsMs = [];
    for (let index = 0; index < 30; index += 1) {
      const started = process.hrtime.bigint();
      const response = await fetch(`${controlUrl}/status`, {
        headers: {
          authorization: "Bearer perf-read-token"
        }
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      assert(response.status === 200, `unexpected status response code ${response.status}`);
      readDurationsMs.push(elapsedMs);
      await response.arrayBuffer();
    }

    const readP95 = p95(readDurationsMs);
    assert(
      readP95 <= CONTROL_READ_P95_TARGET_MS,
      `control read p95 ${readP95.toFixed(3)}ms exceeds ${CONTROL_READ_P95_TARGET_MS}ms`
    );

    const eventReaders = [];
    try {
      for (let index = 0; index < SSE_SUBSCRIBER_TARGET; index += 1) {
        const response = await fetch(`${controlUrl}/events`, {
          headers: {
            authorization: "Bearer perf-read-token"
          }
        });
        assert(response.status === 200, `events stream status=${response.status} for subscriber ${index}`);
        const reader = response.body?.getReader();
        assert(reader, `missing readable events stream for subscriber ${index}`);
        eventReaders.push(reader);
      }

      const chunks = await Promise.all(
        eventReaders.map((reader, index) => readWithTimeout(reader, 3_000, `subscriber ${index} first chunk`))
      );
      assert(chunks.every((chunk) => Boolean(chunk.value && chunk.value.length > 0)), "one or more SSE subscribers received no initial chunk");
    } finally {
      await Promise.all(eventReaders.map((reader) => reader.cancel().catch(() => undefined)));
    }
  } finally {
    await controlGateway.stop();
  }

  process.stdout.write(`[performance-smoke] ok queue_submit_p95<=${QUEUE_SUBMIT_P95_TARGET_MS}ms control_read_p95<=${CONTROL_READ_P95_TARGET_MS}ms sse_subscribers=${SSE_SUBSCRIBER_TARGET}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
