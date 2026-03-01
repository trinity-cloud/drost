export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatImageRef {
  id: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  path: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt: string;
  imageRefs?: ChatImageRef[];
}

export interface ChatInputImage {
  mimeType: string;
  dataBase64: string;
}

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
