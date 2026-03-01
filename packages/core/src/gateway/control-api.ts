import http from "node:http";
import { readControlRequestBody } from "./helpers.js";
import {
  broadcastControlRuntimeEvent,
  consumeControlMutationBudget,
  controlAuthResult,
  startControlEventStream
} from "./control-api/auth.js";
import { handleControlGetRequest } from "./control-api/get-routes.js";
import { handleControlPostRequest } from "./control-api/post-routes.js";

export {
  broadcastControlRuntimeEvent,
  consumeControlMutationBudget,
  controlAuthResult,
  startControlEventStream
};

export async function handleControlRequest(
  runtime: any,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const basePath = "/control/v1";
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const isMutation = method !== "GET" && method !== "HEAD";

  const auth = controlAuthResult(runtime, request, isMutation);
  if (!auth.ok) {
    runtime.writeControlJson(response, auth.statusCode ?? 401, {
      ok: false,
      error: auth.message ?? "unauthorized"
    });
    return;
  }

  if (isMutation && auth.mutationKey && !consumeControlMutationBudget(runtime, auth.mutationKey)) {
    runtime.writeControlJson(response, 429, {
      ok: false,
      error: "mutation_rate_limited"
    });
    return;
  }

  if (method === "GET") {
    const handled = handleControlGetRequest({
      runtime,
      basePath,
      pathname,
      url,
      response,
      startControlEventStream: () => startControlEventStream(runtime, request, response)
    });
    if (handled) {
      return;
    }
  }

  let body: Record<string, unknown> = {};
  if (isMutation) {
    let bodyText = "";
    try {
      bodyText = await readControlRequestBody(request);
    } catch (error) {
      runtime.writeControlJson(response, 413, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (bodyText.trim().length > 0) {
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object") {
          body = parsed as Record<string, unknown>;
        } else {
          runtime.writeControlJson(response, 400, {
            ok: false,
            error: "JSON body must be an object"
          });
          return;
        }
      } catch (error) {
        runtime.writeControlJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Invalid JSON"
        });
        return;
      }
    }
  }

  if (method === "POST") {
    const handled = await handleControlPostRequest({
      runtime,
      basePath,
      pathname,
      body,
      response
    });
    if (handled) {
      return;
    }
  }

  runtime.writeControlJson(response, 404, {
    ok: false,
    error: "not_found"
  });
}

export async function startControlServer(runtime: any): Promise<void> {
  if (runtime.controlServer) {
    return;
  }

  const enabled = runtime.config.controlApi?.enabled ?? false;
  if (!enabled) {
    runtime.controlUrl = undefined;
    return;
  }

  const host = runtime.config.controlApi?.host?.trim() || "127.0.0.1";
  const port = runtime.config.controlApi?.port ?? 8788;
  const basePath = "/control/v1";

  const server = http.createServer((request, response) => {
    void handleControlRequest(runtime, request, response).catch((error) => {
      runtime.writeControlJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address && typeof address === "object") {
    runtime.controlUrl = `http://${host}:${address.port}${basePath}`;
  } else {
    runtime.controlUrl = `http://${host}:${port}${basePath}`;
  }
  runtime.controlServer = server;
}

export async function stopControlServer(runtime: any): Promise<void> {
  for (const stream of runtime.controlEventStreams) {
    try {
      stream.end();
    } catch {
      // noop
    }
  }
  runtime.controlEventStreams.clear();
  runtime.controlMutationBuckets.clear();

  const server = runtime.controlServer;
  runtime.controlServer = null;
  runtime.controlUrl = undefined;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
