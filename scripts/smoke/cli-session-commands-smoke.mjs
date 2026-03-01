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
      NO_COLOR: "1",
      DROST_FORCE_INTERACTIVE: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
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

function sendLine(child, line) {
  child.stdin.write(`${line}\n`);
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
  await waitForOutput(first.readOutput, /\[drost\] local session ready\./, 15_000, "initial boot");

  sendLine(first.child, "/new");
  const afterNew = await waitForOutput(
    first.readOutput,
    /\[drost\] active session switched to ([^\s]+) \(provider=/,
    15_000,
    "/new response"
  );
  const createdMatch = afterNew.match(/\[drost\] active session switched to ([^\s]+) \(provider=/);
  if (!createdMatch?.[1]) {
    fail(`could not parse new session id from output:\n${afterNew}`);
  }
  const newSessionId = createdMatch[1];

  sendLine(first.child, "message-new-1");
  await waitForOutput(first.readOutput, /echo:message-new-1/, 15_000, "new session assistant output");

  sendLine(first.child, "/session local");
  await waitForOutput(first.readOutput, /\[drost\] active session switched to local/, 15_000, "switch to local");

  sendLine(first.child, "message-local-1");
  await waitForOutput(first.readOutput, /echo:message-local-1/, 15_000, "local session assistant output");

  sendLine(first.child, "/sessions");
  await waitForOutput(first.readOutput, new RegExp(`\\*?\\s*${newSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), 15_000, "/sessions listing new session");

  await stopCli(first.child, first.readOutput);

  const sessionDir = path.join(workspace, "sessions");
  const localTranscript = path.join(sessionDir, `${encodeURIComponent("local")}.jsonl`);
  const newTranscript = path.join(sessionDir, `${encodeURIComponent(newSessionId)}.jsonl`);
  const localFull = path.join(sessionDir, `${encodeURIComponent("local")}.full.jsonl`);
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
  await waitForOutput(second.readOutput, /\[drost\] local session ready\./, 15_000, "second boot");

  sendLine(second.child, "/sessions");
  await waitForOutput(second.readOutput, /local/, 15_000, "persisted local session list");
  await waitForOutput(
    second.readOutput,
    new RegExp(newSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    15_000,
    "persisted new session list"
  );

  sendLine(second.child, `/session ${newSessionId}`);
  await waitForOutput(
    second.readOutput,
    new RegExp(`\\[drost\\] active session switched to ${newSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(provider=`),
    15_000,
    "switch to persisted new session"
  );

  sendLine(second.child, "message-new-2");
  await waitForOutput(second.readOutput, /echo:message-new-2/, 15_000, "persisted new session assistant output");
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
