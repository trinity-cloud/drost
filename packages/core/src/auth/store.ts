import fs from "node:fs";
import path from "node:path";

export type AuthCredential =
  | {
      type: "api_key";
      value: string;
    }
  | {
      type: "token";
      value: string;
      expiresAt?: number;
    }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken?: string;
      accountId?: string;
      expiresAt?: number;
    };

export interface AuthProfile {
  id: string;
  provider: string;
  credential: AuthCredential;
  createdAt: string;
  updatedAt: string;
}

export interface AuthStore {
  version: 1;
  profiles: Record<string, AuthProfile>;
}

const EMPTY_STORE: AuthStore = {
  version: 1,
  profiles: {}
};

function nowIso(): string {
  return new Date().toISOString();
}

export function loadAuthStore(storePath: string): AuthStore {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthStore>;
    if (parsed.version !== 1 || typeof parsed.profiles !== "object" || !parsed.profiles) {
      return { ...EMPTY_STORE };
    }
    return {
      version: 1,
      profiles: parsed.profiles
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_STORE };
    }
    throw error;
  }
}

export function saveAuthStore(storePath: string, store: AuthStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

export function upsertAuthProfile(params: {
  store: AuthStore;
  id: string;
  provider: string;
  credential: AuthCredential;
}): AuthProfile {
  const existing = params.store.profiles[params.id];
  const createdAt = existing?.createdAt ?? nowIso();
  const next: AuthProfile = {
    id: params.id,
    provider: params.provider,
    credential: params.credential,
    createdAt,
    updatedAt: nowIso()
  };
  params.store.profiles[params.id] = next;
  return next;
}

export function resolveBearerToken(store: AuthStore, profileId: string | undefined): string | null {
  if (!profileId) {
    return null;
  }
  const profile = store.profiles[profileId];
  if (!profile) {
    return null;
  }
  const credential = profile.credential;
  if (credential.type === "api_key" || credential.type === "token") {
    return credential.value;
  }
  return credential.accessToken;
}
