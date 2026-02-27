import type { UsageSnapshot, JsonValue } from "./types.js";

export type NormalizedStreamEventType =
  | "response.delta"
  | "response.completed"
  | "tool.call.started"
  | "tool.call.completed"
  | "usage.updated"
  | "provider.error";

export interface NormalizedStreamEvent {
  type: NormalizedStreamEventType;
  sessionId: string;
  providerId: string;
  timestamp: string;
  payload: {
    text?: string;
    usage?: UsageSnapshot;
    error?: string;
    toolName?: string;
    metadata?: Record<string, JsonValue>;
  };
}

export type StreamEventHandler = (event: NormalizedStreamEvent) => void;
