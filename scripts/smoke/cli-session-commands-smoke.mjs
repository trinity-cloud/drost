import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cliBin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");

function fail(message) {
  throw new Error(`[cli-session-smoke] ${message}`);
}

function createSmokeConfig(workspace) {
  const filePath = path.join(workspace, "drost.config.ts");
  const source = [
    "class SmokeEchoAdapter {",
    "  id = \"smoke-echo-adapter\";",
    "  async probe(profile) {",
    "    return { providerId: profile.id, ok: true, code: \"ok\", message: \"ok\" };",
    "  }",
    "  async runTurn(request) {",
    "    const input = request.messages.filter((entry) => entry.role === \"user\").at(-1)?.content ?? \"\";",
    "    const text = `echo:${input}`;",
    "    request.emit({",
    "      type: \"response.delta\",",
    "      sessionId: request.sessionId,",
    "      providerId: request.providerId,",
    "      timestamp: new Date().toISOString(),",
    "      payload: { text }",
    "    });",
    "    request.emit({",
    "      type: \"response.completed\",",
    "      sessionId: request.sessionId,",
    "      providerId: request.providerId,",
    "      timestamp: new Date().toISOString(),",
    "      payload: { text }",
    "    });",
    "  }",
    "}",
    "",
    "export default {",
    "  workspaceDir: \".\",",
    "  health: { enabled: false },",
    "  controlApi: {",
    "    enabled: true,",
    "    host: \"127.0.0.1\",",
    "    port: 0,",
    "    token: \"smoke-admin\",",
    "    readToken: \"smoke-read\",",
    "    allowLoopbackWithoutAuth: false",
    "  },",
    "  sessionStore: { enabled: true, continuity: { enabled: true, autoOnNew: true } },",
    "  providers: {",
    "    defaultSessionProvider: \"echo\",",
    "    startupProbe: { enabled: false },",
    "    profiles: [",
    "      {",
    "        id: \"echo\",",
    "        adapterId: \"smoke-echo-adapter\",",
    "        kind: \"openai-compatible\",",
    "        model: \"smoke\",",
    "        authProfileId: \"auth:echo\"",
    "      }",
    "    ],",
    "    adapters: [new SmokeEchoAdapter()]",
    "  }",
    "};",
    ""
  ].join("\n");
  fs.writeFileSync(filePath, source, "utf8");
}

function startCli(workspace) {
  const child = spawn(process.execPath, [cliBin, "start", "--ui", "plain"], {
    cwd: workspace,
    env: {
      ...process.env,
      NO_COLOR: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    child,
    readOutput: () => output
  };
}

async function waitForOutput(readOutput, pattern, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const output = readOutput();
    if (pattern.test(output)) {
      return output;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(`timeout waiting for ${label}. output:\n${readOutput()}`);
}

function parseControlUrl(output) {
  const match = output.match(/control=(http:\/\/[^\s|]+)/);
  return match?.[1] ?? null;
}

async function controlFetch(controlUrl, method, route, body) {
  const response = await fetch(`${controlUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer smoke-admin"
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) {
    fail(`control ${method} ${route} failed status=${response.status} payload=${JSON.stringify(payload)}`);
  }
  return payload;
}

async function stopCli(child, readOutput) {
  child.kill("SIGINT");
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`forced SIGKILL after timeout. output:\n${readOutput()}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) {
    fail(`CLI exited with code ${code}. output:\n${readOutput()}`);
  }
}

async function run() {
  if (!fs.existsSync(cliBin)) {
    fail(`CLI dist binary not found: ${cliBin}. Run pnpm build first.`);
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "drost-cli-session-smoke-"));
  createSmokeConfig(workspace);

  const first = startCli(workspace);
  const bootOutput = await waitForOutput(first.readOutput, /\[drost\] gateway: (running|degraded)/, 15_000, "initial boot");
  const controlUrl = parseControlUrl(bootOutput);
  if (!controlUrl) {
    fail(`could not parse control url from output:\n${bootOutput}`);
  }

  const createdLocal = await controlFetch(controlUrl, "POST", "/sessions", {
    channel: "local",
    title: "Local Session"
  });
  const localSessionId = createdLocal.sessionId;
  if (!localSessionId) {
    fail(`missing local session id in create response: ${JSON.stringify(createdLocal)}`);
  }
  const localTurn = await controlFetch(controlUrl, "POST", "/chat/send", {
    sessionId: localSessionId,
    input: "message-local-1"
  });
  if (typeof localTurn.response !== "string" || !localTurn.response.includes("echo:message-local-1")) {
    fail(`unexpected local turn response: ${JSON.stringify(localTurn)}`);
  }

  const createdNew = await controlFetch(controlUrl, "POST", "/sessions", {
    channel: "local",
    title: "New Session",
    fromSessionId: localSessionId
  });
  const newSessionId = createdNew.sessionId;
  if (!newSessionId) {
    fail(`missing new session id in create response: ${JSON.stringify(createdNew)}`);
  }
  const newTurn = await controlFetch(controlUrl, "POST", "/chat/send", {
    sessionId: newSessionId,
    input: "message-new-1"
  });
  if (typeof newTurn.response !== "string" || !newTurn.response.includes("echo:message-new-1")) {
    fail(`unexpected new session turn response: ${JSON.stringify(newTurn)}`);
  }

  const sessionsList = await controlFetch(controlUrl, "GET", "/sessions");
  const listed = Array.isArray(sessionsList.sessions) ? sessionsList.sessions : [];
  if (!listed.some((entry) => entry.sessionId === localSessionId)) {
    fail(`local session missing from /sessions: ${JSON.stringify(sessionsList)}`);
  }
  if (!listed.some((entry) => entry.sessionId === newSessionId)) {
    fail(`new session missing from /sessions: ${JSON.stringify(sessionsList)}`);
  }

  await stopCli(first.child, first.readOutput);

  const sessionDir = path.join(workspace, "sessions");
  const localTranscript = path.join(sessionDir, `${encodeURIComponent(localSessionId)}.jsonl`);
  const newTranscript = path.join(sessionDir, `${encodeURIComponent(newSessionId)}.jsonl`);
  const localFull = path.join(sessionDir, `${encodeURIComponent(localSessionId)}.full.jsonl`);
  const newFull = path.join(sessionDir, `${encodeURIComponent(newSessionId)}.full.jsonl`);
  if (!fs.existsSync(localTranscript) || !fs.existsSync(localFull)) {
    fail("missing local transcript/full session files after first run");
  }
  if (!fs.existsSync(newTranscript) || !fs.existsSync(newFull)) {
    fail("missing new transcript/full session files after first run");
  }
  if (!fs.readFileSync(localTranscript, "utf8").includes("message-local-1")) {
    fail("local transcript missing expected message content");
  }
  if (!fs.readFileSync(newTranscript, "utf8").includes("message-new-1")) {
    fail("new transcript missing expected message content");
  }

  const second = startCli(workspace);
  const secondBootOutput = await waitForOutput(second.readOutput, /\[drost\] gateway: (running|degraded)/, 15_000, "second boot");
  const secondControlUrl = parseControlUrl(secondBootOutput);
  if (!secondControlUrl) {
    fail(`could not parse second control url from output:\n${secondBootOutput}`);
  }

  const persistedList = await controlFetch(secondControlUrl, "GET", "/sessions");
  const persistedSessions = Array.isArray(persistedList.sessions) ? persistedList.sessions : [];
  if (!persistedSessions.some((entry) => entry.sessionId === localSessionId)) {
    fail(`persisted local session missing after restart: ${JSON.stringify(persistedList)}`);
  }
  if (!persistedSessions.some((entry) => entry.sessionId === newSessionId)) {
    fail(`persisted new session missing after restart: ${JSON.stringify(persistedList)}`);
  }

  const followupTurn = await controlFetch(secondControlUrl, "POST", "/chat/send", {
    sessionId: newSessionId,
    input: "message-new-2"
  });
  if (typeof followupTurn.response !== "string" || !followupTurn.response.includes("echo:message-new-2")) {
    fail(`unexpected follow-up turn response: ${JSON.stringify(followupTurn)}`);
  }
  await stopCli(second.child, second.readOutput);

  const newTranscriptAfterRestart = fs.readFileSync(newTranscript, "utf8");
  if (!newTranscriptAfterRestart.includes("message-new-2")) {
    fail("new session transcript missing appended post-restart message");
  }

  process.stdout.write(`[cli-session-smoke] ok workspace=${workspace}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
