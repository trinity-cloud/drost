import type { ChannelAdapter, ChannelAdapterContext, ChannelTurnRequest } from "@drost/core";

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

export interface TelegramChannelOptions {
  token: string;
  pollIntervalMs?: number;
  workspaceId?: string;
  apiBaseUrl?: string;
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

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";

  private readonly token: string;
  private readonly pollIntervalMs: number;
  private readonly workspaceId?: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (error: Error) => void;

  private context: ChannelAdapterContext | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private offset = 0;

  constructor(options: TelegramChannelOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("Telegram token is required");
    }
    this.token = token;
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1000);
    this.workspaceId = options.workspaceId;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onError = options.onError;
  }

  connect(context: ChannelAdapterContext): void {
    this.context = context;
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    void this.pollOnce();
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.context = null;
    // Let any in-flight poll finish naturally.
    await Promise.resolve();
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

  private async pollOnce(): Promise<void> {
    if (!this.context || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const updates = await this.fetchUpdates();
      for (const update of updates) {
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id)) {
          this.offset = Math.max(this.offset, update.update_id + 1);
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

        const request: ChannelTurnRequest = {
          identity: {
            channel: "telegram",
            workspaceId: this.workspaceId,
            chatId: String(chatId),
            userId: message.from?.id !== undefined ? String(message.from.id) : undefined
          },
          title: message.chat?.title,
          input
        };
        const result = await this.context.runTurn(request);
        const response = result.response.trim();
        if (!response) {
          continue;
        }
        await this.sendMessage(chatId, response.slice(0, 4000));
      }
    } catch (error) {
      this.reportError(error);
    } finally {
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

  private async sendMessage(chatId: number, text: string): Promise<void> {
    const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "sendMessage"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });
    await parseApiResponse<Record<string, unknown>>(response);
  }
}

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannelAdapter {
  return new TelegramChannelAdapter(options);
}
