import type { StreamEventHandler } from "./events.js";
import type { ChannelSessionIdentity, ChannelSessionMappingOptions } from "./session-mapping.js";

export interface ChannelTurnRequest {
  identity: ChannelSessionIdentity;
  input: string;
  title?: string;
  mapping?: ChannelSessionMappingOptions;
  onEvent?: StreamEventHandler;
  signal?: AbortSignal;
}

export interface ChannelTurnResult {
  sessionId: string;
  providerId?: string;
  response: string;
}

export interface ChannelAdapterContext {
  runTurn: (request: ChannelTurnRequest) => Promise<ChannelTurnResult>;
}

export interface ChannelAdapter {
  id: string;
  connect: (context: ChannelAdapterContext) => Promise<void> | void;
  disconnect?: () => Promise<void> | void;
}
