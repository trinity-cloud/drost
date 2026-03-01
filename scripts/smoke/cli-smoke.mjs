import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cliBin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");

function fail(message) {
  throw new Error(`[cli-smoke] ${message}`);
}

function runCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function run() {
  if (!fs.existsSync(cliBin)) {
    fail(`CLI dist binary not found: ${cliBin}. Run pnpm build first.`);
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "drost-cli-smoke-"));
  fs.writeFileSync(
    path.join(workspace, "drost.config.json"),
    JSON.stringify(
      {
        workspaceDir: ".",
        health: {
          enabled: false
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const providersList = await runCommand(["providers", "list"], { cwd: workspace });
  if (providersList.code !== 0) {
    fail(`providers list failed: ${providersList.stderr || providersList.stdout}`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, "start", "--ui", "plain"], {
      cwd: workspace,
      env: {
        ...process.env,
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let exited = false;

    const timeout = setTimeout(() => {
      if (!exited) {
        child.kill("SIGKILL");
        reject(new Error(`start timeout. output:\n${output}`));
      }
    }, 15000);

    const maybeReady = () => {
      if (!output.includes("gateway: running") && !output.includes("gateway: degraded")) {
        return;
      }
      child.kill("SIGINT");
    };

    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      maybeReady();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
      maybeReady();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`start exited with code ${code}. output:\n${output}`));
        return;
      }
      resolve();
    });
  });

  process.stdout.write(`[cli-smoke] ok workspace=${workspace}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
