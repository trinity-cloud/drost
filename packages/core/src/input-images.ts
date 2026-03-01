import fs from "node:fs";
import path from "node:path";
import type { ChatInputImage } from "./types.js";

const DEFAULT_IMAGE_MIME = "image/jpeg";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff"
};

function normalizeImageMimeType(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed.startsWith("image/")) {
    return DEFAULT_IMAGE_MIME;
  }
  return trimmed;
}

function inferImageMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).trim().toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? DEFAULT_IMAGE_MIME;
}

function normalizeBase64(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function decodeBase64(value: string): Buffer {
  const normalized = normalizeBase64(value);
  if (!normalized) {
    throw new Error("Image base64 payload is empty");
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new Error("Image base64 payload contains invalid characters");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) {
    throw new Error("Image base64 payload decoded to empty bytes");
  }
  return buffer;
}

function parseDataUrlImage(value: string): ChatInputImage | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = normalizeImageMimeType(match[1]);
  const dataBase64 = normalizeBase64(match[2] ?? "");
  decodeBase64(dataBase64);
  return {
    mimeType,
    dataBase64
  };
}

function readImageFromPath(filePath: string, cwd: string, mimeType?: string): ChatInputImage {
  const resolvedPath = path.resolve(cwd, filePath);
  const bytes = fs.readFileSync(resolvedPath);
  if (bytes.length === 0) {
    throw new Error(`Image path contains no bytes: ${resolvedPath}`);
  }
  return {
    mimeType: mimeType ? normalizeImageMimeType(mimeType) : inferImageMimeTypeFromPath(resolvedPath),
    dataBase64: bytes.toString("base64")
  };
}

function fromUnknownRecord(record: Record<string, unknown>, cwd: string): ChatInputImage {
  const pathValue = typeof record.path === "string" ? record.path.trim() : "";
  if (pathValue) {
    return readImageFromPath(pathValue, cwd, typeof record.mimeType === "string" ? record.mimeType : undefined);
  }

  const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl : "";
  if (dataUrl.trim()) {
    const parsed = parseDataUrlImage(dataUrl);
    if (!parsed) {
      throw new Error("Invalid image dataUrl payload");
    }
    return parsed;
  }

  const base64 =
    typeof record.dataBase64 === "string"
      ? record.dataBase64
      : typeof record.data === "string"
        ? record.data
        : "";
  const normalized = normalizeBase64(base64);
  decodeBase64(normalized);
  return {
    mimeType: normalizeImageMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined),
    dataBase64: normalized
  };
}

export function normalizeChatInputImages(raw: unknown, options?: { cwd?: string }): ChatInputImage[] {
  if (!raw) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("images must be an array");
  }

  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const normalized: ChatInputImage[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error("image entries must be objects");
    }
    const image = fromUnknownRecord(item as Record<string, unknown>, cwd);
    normalized.push(image);
  }

  return normalized;
}

export function imageDataUrl(image: ChatInputImage): string {
  return `data:${normalizeImageMimeType(image.mimeType)};base64,${normalizeBase64(image.dataBase64)}`;
}

export function imageExtensionForMimeType(mimeType: string): string {
  return EXTENSION_BY_MIME[normalizeImageMimeType(mimeType)] ?? ".jpg";
}

export function imageBytesFromBase64(dataBase64: string): Buffer {
  return decodeBase64(dataBase64);
}
