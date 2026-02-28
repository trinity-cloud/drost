import fs from "node:fs";
import path from "node:path";
import { isChannelCommand } from "@drost/core";
import type { ChannelAdapter, ChannelAdapterContext, ChannelTurnRequest } from "@drost/core";
import {
  renderTelegramFinalMessage,
  renderTelegramStreamingPreview,
  stripTelegramHtml
} from "./telegram-renderer.js";

interface TelegramUpdateMessage {
  message_id: number;
  text?: string;
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramUpdateMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  description?: string;
  result: T;
}

interface TelegramSendMessageResult {
  message_id: number;
}

interface TelegramChannelState {
  version: 1;
  offset: number;
  lastMessageIdsByChat: Record<string, number>;
  updatedAt: string;
}

interface TelegramMessagePayload {
  text: string;
  parseMode?: "HTML";
}

const TELEGRAM_MAX_MESSAGE_CHARS = 4000;
const DEFAULT_TYPING_INTERVAL_MS = 4000;
const DEFAULT_STREAM_FLUSH_INTERVAL_MS = 200;
const DEFAULT_STREAM_PREVIEW_CHARS = 200;
const DEFAULT_SYNTHETIC_STREAM_STEP_CHARS = 120;
const DEFAULT_SYNTHETIC_STREAM_INTERVAL_MS = 60;
const DEFAULT_STATE_DIR = ".drost/channels";

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function parseApiResponse<T>(response: Response): Promise<TelegramApiResponse<T>> {
  const body = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok) {
    throw new Error(`Telegram request failed with status ${response.status}`);
  }
  if (!body.ok) {
    throw new Error(body.description || "Telegram API returned ok=false");
  }
  return body;
}

function buildApiUrl(baseUrl: string, token: string, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/bot${token}/${method}`;
}

function toSafePathSuffix(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "default";
  }
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "default";
}

function mergeStreamText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    // Snapshot-style chunk (provider re-sent the full text so far).
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    // Duplicate or stale snapshot; keep the longest seen text.
    return existing;
  }

  // Incremental chunk with overlap: append only the non-overlapping suffix.
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
    if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";

  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly workspaceId?: string;
  private readonly apiBaseUrl: string;
  private readonly typingIntervalMs: number;
  private readonly streamFlushIntervalMs: number;
  private readonly streamPreviewChars: number;
  private readonly syntheticStreamStepChars: number;
  private readonly syntheticStreamIntervalMs: number;
  private readonly stateFilePath: string;
  private readonly lockFilePath: string;
  private readonly persistState: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (error: Error) => void;

  private context: ChannelAdapterContext | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private offset = 0;
  private lockFd: number | null = null;
  private readonly lastMessageIdsByChat = new Map<string, number>();

  constructor(options: TelegramChannelOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("Telegram token is required");
    }
    this.token = token;
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1000);
    this.workspaceId = options.workspaceId;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.typingIntervalMs = Math.max(1000, options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS);
    this.streamFlushIntervalMs = Math.max(1, options.streamFlushIntervalMs ?? DEFAULT_STREAM_FLUSH_INTERVAL_MS);
    this.streamPreviewChars = Math.max(24, options.streamPreviewChars ?? DEFAULT_STREAM_PREVIEW_CHARS);
    this.syntheticStreamStepChars = Math.max(24, options.syntheticStreamStepChars ?? DEFAULT_SYNTHETIC_STREAM_STEP_CHARS);
    this.syntheticStreamIntervalMs = Math.max(10, options.syntheticStreamIntervalMs ?? DEFAULT_SYNTHETIC_STREAM_INTERVAL_MS);
    this.persistState = options.persistState ?? true;
    const suffix = toSafePathSuffix(this.workspaceId);
    const defaultStateDir = path.resolve(process.cwd(), DEFAULT_STATE_DIR);
    this.stateFilePath =
      options.stateFilePath?.trim() && options.stateFilePath.trim().length > 0
        ? path.resolve(options.stateFilePath)
        : path.join(defaultStateDir, `telegram-${suffix}.json`);
    this.lockFilePath =
      options.lockFilePath?.trim() && options.lockFilePath.trim().length > 0
        ? path.resolve(options.lockFilePath)
        : path.join(defaultStateDir, `telegram-${suffix}.lock`);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;
  }

  connect(context: ChannelAdapterContext): void {
    this.context = context;
    if (this.pollTimer) {
      return;
    }
    try {
      this.acquirePollLock();
      this.loadState();
    } catch (error) {
      this.reportError(error);
      this.context = null;
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    void this.pollOnce();
    void this.registerBotCommands();
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.releasePollLock();
    this.context = null;
    // Let any in-flight poll finish naturally.
    await Promise.resolve();
  }

  private ensureStateDirectoryExists(): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });
  }

  private acquirePollLock(): void {
    if (!this.persistState || this.lockFd !== null) {
      return;
    }
    this.ensureStateDirectoryExists();
    try {
      this.lockFd = this.openPollLockFile();
      fs.writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
    } catch (error) {
      throw new Error(
        `Telegram channel lock already held (${this.lockFilePath}). Stop other drost process or remove stale lock.`
      );
    }
  }

  private openPollLockFile(): number {
    try {
      return fs.openSync(this.lockFilePath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }

      const existingPid = this.readExistingLockPid();
      if (existingPid !== null && !this.isProcessAlive(existingPid)) {
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          // If cleanup fails, the retry below will surface the same EEXIST lock error.
        }
        return fs.openSync(this.lockFilePath, "wx");
      }
      throw error;
    }
  }

  private readExistingLockPid(): number | null {
    try {
      const raw = fs.readFileSync(this.lockFilePath, "utf8").trim();
      if (!raw) {
        return null;
      }
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private releasePollLock(): void {
    if (this.lockFd === null) {
      return;
    }
    try {
      fs.closeSync(this.lockFd);
    } catch {
      // Ignore close errors during shutdown.
    }
    this.lockFd = null;
    try {
      fs.unlinkSync(this.lockFilePath);
    } catch {
      // Ignore stale/missing lock cleanup failures.
    }
  }

  private loadState(): void {
    if (!this.persistState) {
      return;
    }
    this.ensureStateDirectoryExists();
    if (!fs.existsSync(this.stateFilePath)) {
      return;
    }
    let state: unknown;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFilePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Failed to parse telegram state file ${this.stateFilePath}: ${toError(error).message}`
      );
    }
    if (!state || typeof state !== "object") {
      return;
    }
    const record = state as Partial<TelegramChannelState>;
    if (typeof record.offset === "number" && Number.isFinite(record.offset) && record.offset >= 0) {
      this.offset = Math.floor(record.offset);
    }
    this.lastMessageIdsByChat.clear();
    if (record.lastMessageIdsByChat && typeof record.lastMessageIdsByChat === "object") {
      for (const [chatId, value] of Object.entries(record.lastMessageIdsByChat)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          this.lastMessageIdsByChat.set(chatId, Math.floor(value));
        }
      }
    }
  }

  private persistStateToDisk(): void {
    if (!this.persistState) {
      return;
    }
    this.ensureStateDirectoryExists();
    const lastMessageIdsByChat: Record<string, number> = {};
    for (const [chatId, value] of this.lastMessageIdsByChat.entries()) {
      if (Number.isFinite(value) && value >= 0) {
        lastMessageIdsByChat[chatId] = Math.floor(value);
      }
    }
    const state: TelegramChannelState = {
      version: 1,
      offset: Math.max(0, Math.floor(this.offset)),
      lastMessageIdsByChat,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private wasMessageAlreadyProcessed(chatId: number, messageId: number): boolean {
    const key = String(chatId);
    const last = this.lastMessageIdsByChat.get(key);
    return typeof last === "number" && Number.isFinite(last) && messageId <= last;
  }

  private markMessageProcessed(chatId: number, messageId: number): void {
    const key = String(chatId);
    const last = this.lastMessageIdsByChat.get(key) ?? 0;
    if (messageId > last) {
      this.lastMessageIdsByChat.set(key, messageId);
    }
  }

  private reportError(error: unknown): void {
    const normalized = toError(error);
    if (this.onError) {
      this.onError(normalized);
      return;
    }
    // Avoid throwing from polling loop; default to stderr logging.
    process.stderr.write(`[drost][telegram] ${normalized.message}\n`);
  }

  private isNotModifiedError(error: unknown): boolean {
    const message = toError(error).message.toLowerCase();
    return message.includes("message is not modified");
  }

  private splitTelegramText(input: string): string[] {
    const text = input.trim();
    if (!text) {
      return [];
    }
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += TELEGRAM_MAX_MESSAGE_CHARS) {
      chunks.push(text.slice(offset, offset + TELEGRAM_MAX_MESSAGE_CHARS));
    }
    return chunks;
  }

  private chunkPlainMessage(text: string): TelegramMessagePayload[] {
    return this.splitTelegramText(text).map((chunk) => ({
      text: chunk
    }));
  }

  private buildFinalTelegramPayloads(rawAssistantText: string): TelegramMessagePayload[] {
    const rendered = renderTelegramFinalMessage(rawAssistantText, {
      maxHtmlChars: TELEGRAM_MAX_MESSAGE_CHARS
    });
    if (!rendered.text.trim()) {
      return [];
    }

    if (rendered.parseMode === "HTML") {
      return [
        {
          text: rendered.text,
          parseMode: "HTML"
        }
      ];
    }

    return this.chunkPlainMessage(rendered.text);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private startTypingSignal(chatId: number): { stop: () => void } {
    let stopped = false;
    const sendOnce = (): void => {
      if (stopped) {
        return;
      }
      void this.sendChatAction(chatId, "typing").catch((error) => {
        this.reportError(error);
      });
    };

    sendOnce();
    const timer = setInterval(() => {
      sendOnce();
    }, this.typingIntervalMs);

    return {
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(timer);
      }
    };
  }

  private async handleTurnResponseStreaming(chatId: number, request: ChannelTurnRequest): Promise<void> {
    if (!this.context) {
      return;
    }

    const typing = this.startTypingSignal(chatId);
    let streamedText = "";
    let streamedPreviewText = "";
    let leadMessageId: number | null = null;
    let leadText = "";
    let streamTicker: NodeJS.Timeout | null = null;
    let flushInProgress = false;
    let pendingFlush: Promise<void> | null = null;

    const flushLead = async (force = false, previewFirst = false): Promise<void> => {
      if (flushInProgress) {
        return;
      }
      const chunks = this.splitTelegramText(streamedPreviewText);
      let nextLead = chunks[0] ?? "";
      if (!nextLead) {
        return;
      }
      if (leadMessageId === null && previewFirst && nextLead.length > this.streamPreviewChars) {
        nextLead = nextLead.slice(0, this.streamPreviewChars);
      }
      if (!force && nextLead === leadText) {
        return;
      }

      flushInProgress = true;
      try {
        if (leadMessageId === null) {
          leadMessageId = await this.sendMessage(chatId, nextLead);
        } else {
          try {
            await this.editMessage(chatId, leadMessageId, nextLead);
          } catch (error) {
            if (!this.isNotModifiedError(error)) {
              throw error;
            }
          }
        }
        leadText = nextLead;
      } finally {
        flushInProgress = false;
      }
    };

    const animateLeadTo = async (targetText: string): Promise<void> => {
      if (!targetText || leadText === targetText) {
        return;
      }

      if (leadMessageId === null) {
        const seed = targetText.slice(0, Math.min(this.streamPreviewChars, targetText.length));
        leadMessageId = await this.sendMessage(chatId, seed);
        leadText = seed;
      } else if (leadText.length === 0) {
        const seed = targetText.slice(0, Math.min(this.streamPreviewChars, targetText.length));
        await this.editMessage(chatId, leadMessageId, seed);
        leadText = seed;
      }

      if (leadText === targetText || !leadMessageId) {
        return;
      }

      const remaining = targetText.length - leadText.length;
      const minStep = this.syntheticStreamStepChars;
      const adaptiveStep = Math.max(minStep, Math.ceil(remaining / 18));
      let cursor = leadText.length;
      while (cursor < targetText.length) {
        cursor = Math.min(targetText.length, cursor + adaptiveStep);
        const next = targetText.slice(0, cursor);
        try {
          await this.editMessage(chatId, leadMessageId, next);
          leadText = next;
        } catch (error) {
          if (!this.isNotModifiedError(error)) {
            throw error;
          }
        }
        if (cursor < targetText.length) {
          await this.sleep(this.syntheticStreamIntervalMs);
        }
      }
    };

    const ensureStreamTicker = (): void => {
      if (streamTicker) {
        return;
      }
      streamTicker = setInterval(() => {
        void flushLead().catch((error) => this.reportError(error));
      }, this.streamFlushIntervalMs);
    };

    try {
      const result = await this.context.runTurn({
        ...request,
        onEvent: (event) => {
          request.onEvent?.(event);
          if (event.type !== "response.delta") {
            return;
          }
          const delta = toText(event.payload.text);
          if (!delta) {
            return;
          }
          const nextStreamedText = mergeStreamText(streamedText, delta);
          if (nextStreamedText === streamedText) {
            return;
          }
          streamedText = nextStreamedText;
          const nextPreviewText = renderTelegramStreamingPreview(streamedText);
          if (nextPreviewText === streamedPreviewText) {
            return;
          }
          streamedPreviewText = nextPreviewText;
          if (leadMessageId === null && !pendingFlush) {
            // Ensure the first visible chunk appears immediately, then edit in place.
            pendingFlush = flushLead(false, true).catch((error) => this.reportError(error));
          }
          ensureStreamTicker();
        }
      });

      if (streamTicker) {
        clearInterval(streamTicker);
        streamTicker = null;
      }
      // Await any in-flight flush so leadMessageId is settled before finalization.
      if (pendingFlush) {
        await pendingFlush;
        pendingFlush = null;
      }
      await flushLead(true);

      const streamedFinalText = renderTelegramStreamingPreview(streamedText);
      const fallbackFinalText = renderTelegramStreamingPreview(result.response);
      const finalRawText =
        streamedFinalText.trim().length > 0 ? streamedText : result.response;
      const finalPayloads = this.buildFinalTelegramPayloads(
        finalRawText.trim().length > 0 ? finalRawText : `${streamedFinalText || fallbackFinalText}`
      );
      if (finalPayloads.length === 0) {
        return;
      }

      const firstPayload = finalPayloads[0]!;
      const shouldAnimate =
        firstPayload.parseMode === undefined &&
        firstPayload.text.length > this.streamPreviewChars &&
        (leadText.length === 0 || leadText.length < firstPayload.text.length);
      if (shouldAnimate) {
        await animateLeadTo(firstPayload.text);
      } else if (leadMessageId === null) {
        leadMessageId = await this.sendMessage(chatId, firstPayload.text, firstPayload.parseMode);
        leadText = firstPayload.text;
      } else if (firstPayload.text !== leadText || firstPayload.parseMode === "HTML") {
        try {
          await this.editMessage(chatId, leadMessageId, firstPayload.text, firstPayload.parseMode);
        } catch (error) {
          if (!this.isNotModifiedError(error)) {
            throw error;
          }
        }
        leadText = firstPayload.text;
      }

      for (let index = 1; index < finalPayloads.length; index += 1) {
        const payload = finalPayloads[index];
        if (!payload || !payload.text) {
          continue;
        }
        await this.sendMessage(chatId, payload.text, payload.parseMode);
      }
    } finally {
      if (streamTicker) {
        clearInterval(streamTicker);
        streamTicker = null;
      }
      typing.stop();
    }
  }

  private static readonly BOT_COMMANDS = [
    { command: "help", description: "Show available commands" },
    { command: "status", description: "Gateway status" },
    { command: "providers", description: "List provider profiles" },
    { command: "provider", description: "Switch provider for next turn" },
    { command: "session", description: "Current session info" },
    { command: "sessions", description: "List all sessions" },
    { command: "tools", description: "List loaded tools" },
    { command: "tool", description: "Run a tool" },
    { command: "restart", description: "Restart the gateway" }
  ];

  private async registerBotCommands(): Promise<void> {
    const scopes = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" }
    ];

    try {
      // Clear commands from all standard scopes to remove stale menus from previous servers.
      for (const scope of scopes) {
        const deleteResponse = await this.fetchImpl(
          buildApiUrl(this.apiBaseUrl, this.token, "deleteMyCommands"),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope })
          }
        );
        await parseApiResponse<boolean>(deleteResponse);
      }

      // Register commands on the default scope.
      const setResponse = await this.fetchImpl(
        buildApiUrl(this.apiBaseUrl, this.token, "setMyCommands"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commands: TelegramChannelAdapter.BOT_COMMANDS
          })
        }
      );
      await parseApiResponse<boolean>(setResponse);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.context || this.polling) {
      return;
    }
    this.polling = true;
    let stateChanged = false;
    try {
      const updates = await this.fetchUpdates();
      for (const update of updates) {
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id) && update.update_id >= 0) {
          const nextOffset = Math.max(this.offset, update.update_id + 1);
          if (nextOffset !== this.offset) {
            this.offset = nextOffset;
            stateChanged = true;
          }
        }
        const message = update.message;
        if (!message) {
          continue;
        }
        const input = toText(message.text).trim();
        const chatId = message.chat?.id;
        if (!input || chatId === undefined) {
          continue;
        }
        if (
          typeof message.message_id === "number" &&
          Number.isFinite(message.message_id) &&
          message.message_id >= 0 &&
          this.wasMessageAlreadyProcessed(chatId, message.message_id)
        ) {
          continue;
        }

        const identity = {
          channel: "telegram" as const,
          workspaceId: this.workspaceId,
          chatId: String(chatId),
          userId: message.from?.id !== undefined ? String(message.from.id) : undefined
        };

        // Intercept slash commands before routing to the LLM.
        if (isChannelCommand(input) && this.context?.dispatchCommand) {
          const commandResult = await this.context.dispatchCommand({ identity, input });
          if (commandResult.handled && commandResult.text) {
            const chunks = this.splitTelegramText(commandResult.text);
            for (const chunk of chunks) {
              await this.sendMessage(chatId, chunk);
            }
          }
          if (commandResult.handled) {
            if (typeof message.message_id === "number" && Number.isFinite(message.message_id) && message.message_id >= 0) {
              this.markMessageProcessed(chatId, Math.floor(message.message_id));
              stateChanged = true;
            }
            continue;
          }
          // Not handled — fall through to normal turn.
        }

        const request: ChannelTurnRequest = {
          identity,
          title: message.chat?.title,
          input
        };
        await this.handleTurnResponseStreaming(chatId, request);
        if (typeof message.message_id === "number" && Number.isFinite(message.message_id) && message.message_id >= 0) {
          this.markMessageProcessed(chatId, Math.floor(message.message_id));
          stateChanged = true;
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      if (stateChanged) {
        try {
          this.persistStateToDisk();
        } catch (error) {
          this.reportError(error);
        }
      }
      this.polling = false;
    }
  }

  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(buildApiUrl(this.apiBaseUrl, this.token, "getUpdates"));
    url.searchParams.set("timeout", "0");
    if (this.offset > 0) {
      url.searchParams.set("offset", String(this.offset));
    }
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await this.fetchImpl(url.toString(), {
      method: "GET"
    });
    const payload = await parseApiResponse<TelegramUpdate[]>(response);
    return Array.isArray(payload.result) ? payload.result : [];
  }

  private async sendMessage(
    chatId: number,
    text: string,
    parseMode?: "HTML",
    allowFallback = true
  ): Promise<number> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text
    };
    if (parseMode) {
      payload.parse_mode = parseMode;
      payload.link_preview_options = {
        is_disabled: true
      };
    }

    try {
      const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "sendMessage"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const apiPayload = await parseApiResponse<TelegramSendMessageResult>(response);
      if (typeof apiPayload.result?.message_id !== "number") {
        throw new Error("Telegram sendMessage response missing message_id");
      }
      return apiPayload.result.message_id;
    } catch (error) {
      if (!parseMode || !allowFallback) {
        throw error;
      }
      return await this.sendMessage(chatId, stripTelegramHtml(text), undefined, false);
    }
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: "HTML",
    allowFallback = true
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text
    };
    if (parseMode) {
      payload.parse_mode = parseMode;
      payload.link_preview_options = {
        is_disabled: true
      };
    }

    try {
      const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "editMessageText"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      await parseApiResponse<Record<string, unknown>>(response);
    } catch (error) {
      if (!parseMode || !allowFallback) {
        throw error;
      }
      await this.editMessage(chatId, messageId, stripTelegramHtml(text), undefined, false);
    }
  }

  private async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "sendChatAction"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        action
      })
    });
    await parseApiResponse<Record<string, unknown>>(response);
  }
}

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannelAdapter {
  return new TelegramChannelAdapter(options);
}
