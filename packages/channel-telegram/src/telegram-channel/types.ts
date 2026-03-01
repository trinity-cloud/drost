import type { ChannelAdapterContext, ChannelTurnRequest, ChatInputImage } from "@drost/core";

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramUpdateMessage {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  chat?: {
    id?: number;
    title?: string;
    type?: string;
  };
  from?: {
    id?: number;
    username?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
    [key: string]: unknown;
  };
  result: T;
}

export interface TelegramGetFileResult {
  file_id: string;
  file_path?: string;
}

export interface TelegramSendMessageResult {
  message_id: number;
}

export interface TelegramChannelState {
  version: 1;
  offset: number;
  lastMessageIdsByChat: Record<string, number>;
  sessionPrefixByChat?: Record<string, string>;
  updatedAt: string;
}

export interface TelegramMessagePayload {
  text: string;
  parseMode?: "HTML";
}

export interface TelegramInboundTurnInput {
  input: string;
  inputImages: ChatInputImage[];
}

export const TELEGRAM_MAX_MESSAGE_CHARS = 4000;
export const DEFAULT_TYPING_INTERVAL_MS = 4000;
export const DEFAULT_STREAM_FLUSH_INTERVAL_MS = 200;
export const DEFAULT_STREAM_PREVIEW_CHARS = 200;
export const DEFAULT_SYNTHETIC_STREAM_STEP_CHARS = 120;
export const DEFAULT_SYNTHETIC_STREAM_INTERVAL_MS = 60;
export const DEFAULT_STATE_DIR = ".drost/channels";

export const TELEGRAM_BOT_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Gateway status" },
  { command: "providers", description: "List provider profiles" },
  { command: "provider", description: "Switch provider for next turn" },
  { command: "session", description: "Current session info" },
  { command: "sessions", description: "List recent sessions" },
  { command: "new", description: "Start a new session" },
  { command: "tools", description: "List loaded tools" },
  { command: "tool", description: "Run a tool" },
  { command: "restart", description: "Restart the gateway" }
] as const;

export interface TelegramChannelOptions {
  token: string;
  pollIntervalMs?: number;
  workspaceId?: string;
  apiBaseUrl?: string;
  typingIntervalMs?: number;
  streamFlushIntervalMs?: number;
  streamPreviewChars?: number;
  syntheticStreamStepChars?: number;
  syntheticStreamIntervalMs?: number;
  stateFilePath?: string;
  lockFilePath?: string;
  persistState?: boolean;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}

export interface TelegramStreamingRuntime {
  context: ChannelAdapterContext;
  request: ChannelTurnRequest;
  chatId: number;
  typingIntervalMs: number;
  streamFlushIntervalMs: number;
  streamPreviewChars: number;
  syntheticStreamStepChars: number;
  syntheticStreamIntervalMs: number;
  sendMessage: (chatId: number, text: string, parseMode?: "HTML") => Promise<number>;
  editMessage: (chatId: number, messageId: number, text: string, parseMode?: "HTML") => Promise<void>;
  sendChatAction: (chatId: number, action: "typing") => Promise<void>;
  reportError: (error: unknown) => void;
  isNotModifiedError: (error: unknown) => boolean;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function toSafePathSuffix(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "default";
  }
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "default";
}

export function isNotModifiedError(error: unknown): boolean {
  const message = toError(error).message.toLowerCase();
  return message.includes("message is not modified");
}
