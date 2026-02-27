import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  type AuthStore,
  loadAuthStore,
  saveAuthStore,
  upsertAuthProfile,
  loadCodexOAuthCredential,
  resolveCodexAuthJsonPath,
  type GatewayConfig,
  type ProviderProfile
} from "@drost/core";

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveAuthStorePath(config: GatewayConfig): string {
  if (config.authStorePath) {
    return path.resolve(config.authStorePath);
  }
  return path.resolve(config.workspaceDir, ".drost", "auth-profiles.json");
}

function resolveStorePath(config: GatewayConfig): string {
  return resolveAuthStorePath(config);
}

function credentialSummary(store: AuthStore, profileId: string): string {
  const profile = store.profiles[profileId];
  if (!profile) {
    return "missing";
  }
  const credential = profile.credential;
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  drost auth list",
      "  drost auth doctor",
      "  drost auth codex-import [profileId] [--path /path/to/auth.json]",
      "  drost auth set-api-key <provider> <profileId> <apiKey>",
      "  drost auth set-token <provider> <profileId> <token>",
      "  drost auth set-setup-token <profileId> <token>   # anthropic shortcut"
    ].join("\n") + "\n"
  );
}

function profileMode(store: AuthStore, profileId: string): string {
  const profile = store.profiles[profileId];
  if (!profile) {
    return "missing";
  }
  const credential = profile.credential;
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function codexLoginActive(): { ok: boolean; message: string } {
  try {
    const result = spawnSync("codex", ["login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const text = [stdout, stderr].filter((entry) => entry.length > 0).join("\n").trim();
    if (result.error) {
      return { ok: false, message: result.error.message };
    }
    if (text.toLowerCase().includes("logged in")) {
      return { ok: true, message: text };
    }
    return { ok: false, message: text || "Codex CLI is not logged in" };
  } catch (error) {
    const commandError = error as Error;
    const message = commandError.message;
    return { ok: false, message };
  }
}

function recommendation(profile: ProviderProfile): string {
  if (profile.adapterId === "codex-exec" || profile.kind === "openai-codex") {
    return "Run `codex login` (preferred), then retry. Optional: `drost auth codex-import` for metadata sync.";
  }
  if (profile.kind === "anthropic") {
    return `Run \`drost auth set-setup-token ${profile.authProfileId} <token>\` or \`drost auth set-api-key anthropic ${profile.authProfileId} <apiKey>\``;
  }
  if (profile.kind === "openai" || profile.kind === "openai-compatible") {
    return `Run \`drost auth set-api-key ${profile.kind} ${profile.authProfileId} <apiKey>\``;
  }
  return `Run \`drost auth set-token ${profile.kind} ${profile.authProfileId} <token>\``;
}

function runDoctor(config: GatewayConfig, store: AuthStore): number {
  const profiles = config.providers?.profiles ?? [];
  if (profiles.length === 0) {
    process.stdout.write("No providers configured. Nothing to validate.\n");
    return 0;
  }

  let problems = 0;
  process.stdout.write("Auth doctor report:\n");
  for (const profile of profiles) {
    if (profile.adapterId === "codex-exec" || profile.kind === "openai-codex") {
      const codex = codexLoginActive();
      if (codex.ok) {
        process.stdout.write(
          `- ${profile.id}  ok=true  auth=codex-cli  message=${codex.message || "logged in"}\n`
        );
      } else {
        problems += 1;
        process.stdout.write(
          `- ${profile.id}  ok=false  auth=codex-cli  message=${codex.message || "not logged in"}\n`
        );
        process.stdout.write(`  fix: ${recommendation(profile)}\n`);
      }
      continue;
    }

    const authProfile = store.profiles[profile.authProfileId];
    if (!authProfile) {
      problems += 1;
      process.stdout.write(
        `- ${profile.id}  ok=false  authProfile=${profile.authProfileId}  message=Missing auth profile\n`
      );
      process.stdout.write(`  fix: ${recommendation(profile)}\n`);
      continue;
    }

    const mode = profileMode(store, profile.authProfileId);
    const providerMatch =
      authProfile.provider.trim().toLowerCase() === profile.kind.trim().toLowerCase() ||
      authProfile.provider.trim().toLowerCase() === profile.adapterId.trim().toLowerCase();
    if (!providerMatch) {
      process.stdout.write(
        `- ${profile.id}  ok=true  authProfile=${profile.authProfileId}  mode=${mode}  warning=provider mismatch (${authProfile.provider})\n`
      );
      continue;
    }

    process.stdout.write(
      `- ${profile.id}  ok=true  authProfile=${profile.authProfileId}  mode=${mode}\n`
    );
  }

  if (problems > 0) {
    process.stdout.write(`\nAuth doctor found ${problems} blocking issue(s).\n`);
    return 2;
  }

  process.stdout.write("\nAuth doctor found no blocking issues.\n");
  return 0;
}

export function runAuthCommand(args: string[], config: GatewayConfig): number {
  const storePath = resolveStorePath(config);
  const store = loadAuthStore(storePath);

  const command = args[0];
  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "codex-import") {
    let profileId = "openai-codex:default";
    let profileSet = false;
    let explicitPath: string | undefined;

    for (let i = 1; i < args.length; i += 1) {
      const token = args[i];
      if (!token) {
        continue;
      }
      if (token === "--path") {
        const next = args[i + 1];
        if (!next) {
          printUsage();
          return 1;
        }
        explicitPath = next;
        i += 1;
        continue;
      }
      if (token.startsWith("--")) {
        process.stderr.write(`Unknown option: ${token}\n`);
        return 1;
      }
      if (!profileSet) {
        profileId = token;
        profileSet = true;
        continue;
      }
      process.stderr.write(`Unexpected argument: ${token}\n`);
      return 1;
    }

    const authPath = explicitPath ? path.resolve(explicitPath) : resolveCodexAuthJsonPath();
    if (!authPath) {
      process.stderr.write("Could not resolve Codex auth json (DROST_CODEX_AUTH_JSON/CODEX_HOME/~/.codex).\n");
      return 1;
    }

    let credential: ReturnType<typeof loadCodexOAuthCredential>;
    try {
      credential = loadCodexOAuthCredential(authPath);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    upsertAuthProfile({
      store,
      id: profileId,
      provider: "openai-codex",
      credential: {
        type: "oauth",
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        accountId: credential.accountId
      }
    });
    saveAuthStore(storePath, store);
    process.stdout.write(
      `Saved ${profileId} from ${credential.sourcePath} at ${nowIso()}\n`
    );
    return 0;
  }

  if (command === "doctor") {
    return runDoctor(config, store);
  }

  if (command === "list") {
    const profileIds = Object.keys(store.profiles).sort((left, right) => left.localeCompare(right));
    if (profileIds.length === 0) {
      process.stdout.write(`No auth profiles in ${storePath}\n`);
      return 0;
    }
    process.stdout.write(`Auth store: ${storePath}\n`);
    for (const profileId of profileIds) {
      const profile = store.profiles[profileId];
      if (!profile) {
        continue;
      }
      process.stdout.write(
        `- ${profileId}  provider=${profile.provider}  mode=${credentialSummary(store, profileId)}\n`
      );
    }
    return 0;
  }

  if (command === "set-api-key") {
    const provider = args[1];
    const profileId = args[2];
    const apiKey = args[3];
    if (!provider || !profileId || !apiKey) {
      printUsage();
      return 1;
    }

    upsertAuthProfile({
      store,
      id: profileId,
      provider,
      credential: {
        type: "api_key",
        value: apiKey
      }
    });
    saveAuthStore(storePath, store);
    process.stdout.write(`Saved API key profile ${profileId} for provider ${provider}\n`);
    return 0;
  }

  if (command === "set-token") {
    const provider = args[1];
    const profileId = args[2];
    const token = args[3];
    if (!provider || !profileId || !token) {
      printUsage();
      return 1;
    }

    upsertAuthProfile({
      store,
      id: profileId,
      provider,
      credential: {
        type: "token",
        value: token
      }
    });
    saveAuthStore(storePath, store);
    process.stdout.write(`Saved token profile ${profileId} for provider ${provider}\n`);
    return 0;
  }

  if (command === "set-setup-token") {
    const profileId = args[1] ?? "anthropic:default";
    const token = args[2];
    if (!token) {
      printUsage();
      return 1;
    }
    upsertAuthProfile({
      store,
      id: profileId,
      provider: "anthropic",
      credential: {
        type: "token",
        value: token
      }
    });
    saveAuthStore(storePath, store);
    process.stdout.write(`Saved setup-token profile ${profileId} for provider anthropic\n`);
    return 0;
  }

  printUsage();
  return 1;
}
