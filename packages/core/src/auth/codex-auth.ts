import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface JsonRecord {
  [key: string]: unknown;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function decodeJwtPayload(token: string): JsonRecord {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return {};
  }
  const payloadBase64 = parts[1];
  const padded = payloadBase64 + "=".repeat((4 - (payloadBase64.length % 4)) % 4);
  try {
    const raw = Buffer.from(padded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as JsonRecord;
  } catch {
    return {};
  }
}

function extractAuthClaims(token: string): { accountId: string } {
  const payload = decodeJwtPayload(token);
  const authClaims = payload["https://api.openai.com/auth"];
  if (!authClaims || typeof authClaims !== "object") {
    return { accountId: "" };
  }
  const claims = authClaims as JsonRecord;
  return {
    accountId: nonEmptyString(claims.chatgpt_account_id)
  };
}

function candidateAuthPaths(explicitPath?: string): string[] {
  const candidates: string[] = [];

  const explicitEnv = nonEmptyString(explicitPath ?? process.env.DROST_CODEX_AUTH_JSON);
  if (explicitEnv) {
    candidates.push(path.resolve(explicitEnv));
  }

  const codexHome = nonEmptyString(process.env.CODEX_HOME) || path.join(os.homedir(), ".codex");
  const resolvedHome = path.resolve(codexHome);
  candidates.push(path.join(resolvedHome, "auth.json"));
  candidates.push(path.join(resolvedHome, "auth", "auth.json"));

  const authDir = path.join(resolvedHome, "auth");
  if (fs.existsSync(authDir) && fs.statSync(authDir).isDirectory()) {
    const jsonFiles = fs
      .readdirSync(authDir)
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(authDir, entry))
      .sort((left, right) => {
        const leftMtime = fs.statSync(left).mtimeMs;
        const rightMtime = fs.statSync(right).mtimeMs;
        return rightMtime - leftMtime;
      });
    candidates.push(...jsonFiles);
  }

  return Array.from(new Set(candidates));
}

export function resolveCodexAuthJsonPath(explicitPath?: string): string | null {
  for (const candidate of candidateAuthPaths(explicitPath)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export interface CodexOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: number;
  sourcePath: string;
}

export function loadCodexOAuthCredential(authJsonPath: string): CodexOAuthCredential {
  const resolvedPath = path.resolve(authJsonPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Codex auth file not found: ${resolvedPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as JsonRecord;
  const directAccess = nonEmptyString(parsed.access_token);
  const tokens = parsed.tokens as JsonRecord | undefined;
  const nestedAccess = nonEmptyString(tokens?.access_token);
  const accessToken = directAccess || nestedAccess;
  if (!accessToken) {
    throw new Error("Codex access token not found in auth payload");
  }

  const refreshToken = nonEmptyString(tokens?.refresh_token) || undefined;
  const directAccountId = nonEmptyString(tokens?.account_id) || undefined;
  const jwtAccountId = extractAuthClaims(accessToken).accountId || undefined;

  let expiresAt: number | undefined;
  try {
    const stat = fs.statSync(resolvedPath);
    expiresAt = stat.mtimeMs + 60 * 60 * 1000;
  } catch {
    expiresAt = undefined;
  }

  return {
    accessToken,
    refreshToken,
    accountId: directAccountId ?? jwtAccountId,
    expiresAt,
    sourcePath: resolvedPath
  };
}
