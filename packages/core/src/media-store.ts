import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageBytesFromBase64, imageExtensionForMimeType } from "./input-images.js";
import type { ChatImageRef, ChatInputImage } from "./types.js";

const MEDIA_ROOT = path.join(".drost", "media");
const MEDIA_INDEX_FILE = path.join(MEDIA_ROOT, "index.jsonl");

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeSessionPart(sessionId: string): string {
  const normalized = sessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "session";
}

function stableImageId(sessionId: string, sha256: string): string {
  return `img_${sanitizeSessionPart(sessionId)}_${sha256.slice(0, 16)}`;
}

function isValidImageRef(value: unknown): value is ChatImageRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.mimeType === "string" &&
    record.mimeType.trim().startsWith("image/") &&
    typeof record.sha256 === "string" &&
    record.sha256.trim().length === 64 &&
    typeof record.bytes === "number" &&
    Number.isFinite(record.bytes) &&
    record.bytes > 0 &&
    typeof record.path === "string" &&
    record.path.trim().length > 0
  );
}

function mediaRelativeDirectory(sessionId: string): string {
  return path.join(MEDIA_ROOT, sanitizeSessionPart(sessionId));
}

function mediaAbsoluteDirectory(workspaceDir: string, sessionId: string): string {
  return path.join(path.resolve(workspaceDir), mediaRelativeDirectory(sessionId));
}

function appendMediaIndexRecord(workspaceDir: string, payload: Record<string, unknown>): void {
  const absoluteWorkspaceDir = path.resolve(workspaceDir);
  const indexPath = path.join(absoluteWorkspaceDir, MEDIA_INDEX_FILE);
  ensureDirectory(path.dirname(indexPath));
  fs.appendFileSync(indexPath, `${JSON.stringify(payload)}\n`, "utf8");
}

function nowIso(): string {
  return new Date().toISOString();
}

function dedupeImageRefs(refs: ChatImageRef[]): ChatImageRef[] {
  const byId = new Map<string, ChatImageRef>();
  for (const ref of refs) {
    byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}

export function persistSessionInputImages(params: {
  workspaceDir: string;
  sessionId: string;
  images: ChatInputImage[];
  source: "control_api" | "channel_turn" | "session_turn";
}): ChatImageRef[] {
  const normalizedSessionId = params.sessionId.trim();
  if (!normalizedSessionId || params.images.length === 0) {
    return [];
  }

  const absoluteWorkspaceDir = path.resolve(params.workspaceDir);
  const absoluteMediaDir = mediaAbsoluteDirectory(absoluteWorkspaceDir, normalizedSessionId);
  const relativeMediaDir = mediaRelativeDirectory(normalizedSessionId);
  ensureDirectory(absoluteMediaDir);

  const refs: ChatImageRef[] = [];
  for (const image of params.images) {
    const bytes = imageBytesFromBase64(image.dataBase64);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const extension = imageExtensionForMimeType(image.mimeType);
    const filename = `${sha256}${extension}`;
    const absolutePath = path.join(absoluteMediaDir, filename);
    if (!fs.existsSync(absolutePath)) {
      fs.writeFileSync(absolutePath, bytes);
    }

    const relativePath = path.join(relativeMediaDir, filename);
    const ref: ChatImageRef = {
      id: stableImageId(normalizedSessionId, sha256),
      mimeType: image.mimeType,
      sha256,
      bytes: bytes.length,
      path: relativePath
    };
    refs.push(ref);
    appendMediaIndexRecord(absoluteWorkspaceDir, {
      version: 1,
      type: "media.image",
      sessionId: normalizedSessionId,
      source: params.source,
      createdAt: nowIso(),
      image: ref
    });
  }

  return dedupeImageRefs(refs);
}

export function resolveInputImageFromRef(params: {
  workspaceDir: string;
  ref: ChatImageRef;
}): ChatInputImage | null {
  if (!isValidImageRef(params.ref)) {
    return null;
  }

  const absoluteWorkspaceDir = path.resolve(params.workspaceDir);
  const absolutePath = path.resolve(absoluteWorkspaceDir, params.ref.path);
  const relative = path.relative(absoluteWorkspaceDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  try {
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.length === 0) {
      return null;
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== params.ref.sha256) {
      return null;
    }
    return {
      mimeType: params.ref.mimeType,
      dataBase64: bytes.toString("base64")
    };
  } catch {
    return null;
  }
}

export function isChatImageRef(value: unknown): value is ChatImageRef {
  return isValidImageRef(value);
}
