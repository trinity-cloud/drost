import crypto from "node:crypto";
import type { SessionOriginIdentity } from "./sessions.js";

export interface ChannelSessionIdentity extends SessionOriginIdentity {}

export interface ChannelSessionMappingOptions {
  prefix?: string;
  includeWorkspace?: boolean;
  maxLength?: number;
}

function normalizePart(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function chooseIdentityPart(identity: ChannelSessionIdentity): string {
  return (
    normalizePart(identity.threadId) ||
    normalizePart(identity.chatId) ||
    normalizePart(identity.userId) ||
    normalizePart(identity.accountId) ||
    "default"
  );
}

export function buildChannelSessionId(
  identity: ChannelSessionIdentity,
  options: ChannelSessionMappingOptions = {}
): string {
  const channel = normalizePart(identity.channel);
  if (!channel) {
    throw new Error("channel is required for channel session mapping");
  }

  const prefix = normalizePart(options.prefix) || "session";
  const includeWorkspace = options.includeWorkspace ?? true;
  const workspace = includeWorkspace ? normalizePart(identity.workspaceId) || "global" : "";
  const principal = chooseIdentityPart(identity);

  const parts = [prefix, channel];
  if (workspace) {
    parts.push(workspace);
  }
  parts.push(principal);
  const raw = parts.join(":");
  const maxLength = options.maxLength ?? 120;
  if (raw.length <= maxLength) {
    return raw;
  }

  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
  return `${prefix}:${channel}:${hash}`;
}

export function createChannelSessionOrigin(identity: ChannelSessionIdentity): SessionOriginIdentity {
  return {
    channel: identity.channel,
    workspaceId: identity.workspaceId,
    accountId: identity.accountId,
    chatId: identity.chatId,
    userId: identity.userId,
    threadId: identity.threadId
  };
}
