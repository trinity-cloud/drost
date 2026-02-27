import fs from "node:fs";

export function sendRestartSignal(pidFilePath: string): { ok: boolean; message: string } {
  if (!fs.existsSync(pidFilePath)) {
    return {
      ok: false,
      message: `Gateway pid file not found: ${pidFilePath}`
    };
  }

  const rawPid = fs.readFileSync(pidFilePath, "utf8").trim();
  const pid = Number.parseInt(rawPid, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      ok: false,
      message: `Invalid gateway pid in ${pidFilePath}`
    };
  }

  try {
    process.kill(pid, "SIGUSR2");
    return {
      ok: true,
      message: `Sent restart signal to gateway process ${pid}`
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
