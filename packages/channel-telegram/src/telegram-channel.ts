import path from "node:path";
import { isChannelCommand } from "@drost/core";
import type { ChannelAdapter, ChannelAdapterContext, ChannelTurnRequest } from "@drost/core";
import { splitTelegramText } from "./telegram-channel/render-utils.js";
import { TelegramApiClient } from "./telegram-channel/api-client.js";
import { TelegramStateStore } from "./telegram-channel/state.js";
import { handleTurnResponseStreaming } from "./telegram-channel/streaming.js";
import {
  DEFAULT_STATE_DIR,
  DEFAULT_STREAM_FLUSH_INTERVAL_MS,
  DEFAULT_STREAM_PREVIEW_CHARS,
  DEFAULT_SYNTHETIC_STREAM_INTERVAL_MS,
  DEFAULT_SYNTHETIC_STREAM_STEP_CHARS,
  DEFAULT_TYPING_INTERVAL_MS,
  type TelegramChannelOptions,
  isNotModifiedError,
  toError,
  toSafePathSuffix,
  toText
} from "./telegram-channel/types.js";

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";

  private readonly pollIntervalMs: number;
  private readonly workspaceId?: string;
  private readonly typingIntervalMs: number;
  private readonly streamFlushIntervalMs: number;
  private readonly streamPreviewChars: number;
  private readonly syntheticStreamStepChars: number;
  private readonly syntheticStreamIntervalMs: number;
  private readonly onError?: (error: Error) => void;
  private readonly state: TelegramStateStore;
  private readonly apiClient: TelegramApiClient;

  private context: ChannelAdapterContext | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(options: TelegramChannelOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("Telegram token is required");
    }

    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1000);
    this.workspaceId = options.workspaceId;
    this.typingIntervalMs = Math.max(1000, options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS);
    this.streamFlushIntervalMs = Math.max(1, options.streamFlushIntervalMs ?? DEFAULT_STREAM_FLUSH_INTERVAL_MS);
    this.streamPreviewChars = Math.max(24, options.streamPreviewChars ?? DEFAULT_STREAM_PREVIEW_CHARS);
    this.syntheticStreamStepChars = Math.max(24, options.syntheticStreamStepChars ?? DEFAULT_SYNTHETIC_STREAM_STEP_CHARS);
    this.syntheticStreamIntervalMs = Math.max(10, options.syntheticStreamIntervalMs ?? DEFAULT_SYNTHETIC_STREAM_INTERVAL_MS);

    const persistState = options.persistState ?? true;
    const suffix = toSafePathSuffix(this.workspaceId);
    const defaultStateDir = path.resolve(process.cwd(), DEFAULT_STATE_DIR);
    const stateFilePath =
      options.stateFilePath?.trim() && options.stateFilePath.trim().length > 0
        ? path.resolve(options.stateFilePath)
        : path.join(defaultStateDir, `telegram-${suffix}.json`);
    const lockFilePath =
      options.lockFilePath?.trim() && options.lockFilePath.trim().length > 0
        ? path.resolve(options.lockFilePath)
        : path.join(defaultStateDir, `telegram-${suffix}.lock`);

    this.state = new TelegramStateStore(stateFilePath, lockFilePath, persistState);
    this.apiClient = new TelegramApiClient(token, options.apiBaseUrl ?? "https://api.telegram.org", options.fetchImpl ?? fetch);
    this.onError = options.onError;
  }

  connect(context: ChannelAdapterContext): void {
    this.context = context;
    if (this.pollTimer) {
      return;
    }
    try {
      this.state.acquirePollLock();
      this.state.loadState();
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
    this.state.releasePollLock();
    this.context = null;
    await Promise.resolve();
  }

  private reportError(error: unknown): void {
    const normalized = toError(error);
    if (this.onError) {
      this.onError(normalized);
      return;
    }
    process.stderr.write(`[drost][telegram] ${normalized.message}\n`);
  }

  private async handleTurn(chatId: number, request: ChannelTurnRequest): Promise<void> {
    if (!this.context) {
      return;
    }
    await handleTurnResponseStreaming({
      context: this.context,
      request,
      chatId,
      typingIntervalMs: this.typingIntervalMs,
      streamFlushIntervalMs: this.streamFlushIntervalMs,
      streamPreviewChars: this.streamPreviewChars,
      syntheticStreamStepChars: this.syntheticStreamStepChars,
      syntheticStreamIntervalMs: this.syntheticStreamIntervalMs,
      sendMessage: (targetChatId, text, parseMode) => this.apiClient.sendMessage(targetChatId, text, parseMode),
      editMessage: (targetChatId, messageId, text, parseMode) => this.apiClient.editMessage(targetChatId, messageId, text, parseMode),
      sendChatAction: (targetChatId, action) => this.apiClient.sendChatAction(targetChatId, action),
      reportError: (error) => this.reportError(error),
      isNotModifiedError
    });
  }

  private async registerBotCommands(): Promise<void> {
    try {
      await this.apiClient.registerBotCommands();
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
      const updates = await this.apiClient.fetchUpdates(this.state.offset);
      for (const update of updates) {
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id) && update.update_id >= 0) {
          const nextOffset = Math.max(this.state.offset, update.update_id + 1);
          if (nextOffset !== this.state.offset) {
            this.state.offset = nextOffset;
            stateChanged = true;
          }
        }

        const message = update.message;
        if (!message) {
          continue;
        }

        const chatId = message.chat?.id;
        if (chatId === undefined) {
          continue;
        }

        const inboundTurn = await this.apiClient.buildInboundTurnInput({
          text: toText(message.text),
          caption: toText(message.caption),
          photo: message.photo
        });
        const input = inboundTurn.input;
        const hasImages = inboundTurn.inputImages.length > 0;
        if (input.length === 0 && !hasImages) {
          continue;
        }

        if (
          typeof message.message_id === "number" &&
          Number.isFinite(message.message_id) &&
          message.message_id >= 0 &&
          this.state.wasMessageAlreadyProcessed(chatId, message.message_id)
        ) {
          continue;
        }

        const identity = {
          channel: "telegram" as const,
          workspaceId: this.workspaceId,
          chatId: String(chatId),
          userId: message.from?.id !== undefined ? String(message.from.id) : undefined
        };

        const prefix = this.state.getSessionPrefix(chatId);
        const mapping = prefix ? { prefix } : undefined;

        if (isChannelCommand(input) && this.context.dispatchCommand) {
          const commandResult = await this.context.dispatchCommand({ identity, input, mapping });
          if (commandResult.handled && commandResult.text) {
            const chunks = splitTelegramText(commandResult.text);
            for (const chunk of chunks) {
              await this.apiClient.sendMessage(chatId, chunk);
            }
          }
          if (commandResult.handled) {
            if (typeof message.message_id === "number" && Number.isFinite(message.message_id) && message.message_id >= 0) {
              this.state.markMessageProcessed(chatId, Math.floor(message.message_id));
              stateChanged = true;
            }
            continue;
          }
        }

        const request: ChannelTurnRequest = {
          identity,
          title: message.chat?.title,
          input,
          inputImages: inboundTurn.inputImages,
          mapping
        };
        await this.handleTurn(chatId, request);
        if (typeof message.message_id === "number" && Number.isFinite(message.message_id) && message.message_id >= 0) {
          this.state.markMessageProcessed(chatId, Math.floor(message.message_id));
          stateChanged = true;
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      if (stateChanged) {
        try {
          this.state.persistStateToDisk();
        } catch (error) {
          this.reportError(error);
        }
      }
      this.polling = false;
    }
  }
}

export type { TelegramChannelOptions } from "./telegram-channel/types.js";

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannelAdapter {
  return new TelegramChannelAdapter(options);
}
