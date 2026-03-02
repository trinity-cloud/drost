import { stripTelegramHtml } from "../telegram-renderer.js";
import {
  TELEGRAM_BOT_COMMANDS,
  type TelegramGetFileResult,
  type TelegramInboundTurnInput,
  type TelegramPhotoSize,
  type TelegramApiResponse,
  type TelegramSendMessageResult,
  type TelegramUpdate
} from "./types.js";

function truncateForLog(value: string, max = 240): string {
  const normalized = value.trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toTelegramApiResponse<T>(record: Record<string, unknown>): TelegramApiResponse<T> | undefined {
  if (typeof record.ok !== "boolean") {
    return undefined;
  }
  return record as unknown as TelegramApiResponse<T>;
}

async function parseApiResponse<T>(response: Response, methodName: string): Promise<TelegramApiResponse<T>> {
  const rawBody = await response.text();
  const parsedBody = parseJsonBody(rawBody);
  const body = parsedBody ? toTelegramApiResponse<T>(parsedBody) : undefined;

  const description =
    body?.description?.trim() ||
    (parsedBody?.description && typeof parsedBody.description === "string"
      ? parsedBody.description.trim()
      : "") ||
    truncateForLog(rawBody);
  const errorCode =
    typeof body?.error_code === "number"
      ? body.error_code
      : typeof parsedBody?.error_code === "number"
        ? parsedBody.error_code
        : undefined;

  if (!response.ok) {
    const details = [
      `Telegram API ${methodName} failed`,
      `status=${response.status}`,
      errorCode !== undefined ? `error_code=${errorCode}` : null,
      description ? `description=${description}` : null
    ]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join(" ");
    throw new Error(details);
  }
  if (!body) {
    throw new Error(`Telegram API ${methodName} returned an invalid response body`);
  }
  if (!body.ok) {
    const details = [
      `Telegram API ${methodName} returned ok=false`,
      errorCode !== undefined ? `error_code=${errorCode}` : null,
      description ? `description=${description}` : null
    ]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join(" ");
    throw new Error(details);
  }
  return body;
}

function buildApiUrl(baseUrl: string, token: string, method: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/bot${token}/${method}`;
}

function buildFileUrl(baseUrl: string, token: string, filePath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/file/bot${token}/${filePath.replace(/^\/+/, "")}`;
}

function inferImageMimeType(filePath: string): string {
  const normalized = filePath.trim().toLowerCase();
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/jpeg";
}

export class TelegramApiClient {
  constructor(
    private readonly token: string,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: typeof fetch
  ) {}

  async registerBotCommands(): Promise<void> {
    const scopes = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" }
    ];

    // Clear commands from standard scopes to remove stale menus.
    for (const scope of scopes) {
      const deleteResponse = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "deleteMyCommands"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope })
      });
      await parseApiResponse<boolean>(deleteResponse, "deleteMyCommands");
    }

    const setResponse = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "setMyCommands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: TELEGRAM_BOT_COMMANDS
      })
    });
    await parseApiResponse<boolean>(setResponse, "setMyCommands");
  }

  async fetchUpdates(offset: number): Promise<TelegramUpdate[]> {
    const url = new URL(buildApiUrl(this.apiBaseUrl, this.token, "getUpdates"));
    url.searchParams.set("timeout", "0");
    if (offset > 0) {
      url.searchParams.set("offset", String(offset));
    }
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await this.fetchImpl(url.toString(), {
      method: "GET"
    });
    const payload = await parseApiResponse<TelegramUpdate[]>(response, "getUpdates");
    return Array.isArray(payload.result) ? payload.result : [];
  }

  async buildInboundTurnInput(params: {
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
  }): Promise<TelegramInboundTurnInput> {
    const input = (params.text && params.text.trim().length > 0 ? params.text : params.caption ?? "").trim();
    const photo = params.photo ?? [];
    if (photo.length === 0) {
      return {
        input,
        inputImages: []
      };
    }
    const largestPhoto = photo
      .filter((entry) => typeof entry?.file_id === "string" && entry.file_id.trim().length > 0)
      .sort((left, right) => {
        const leftSize = (left.width ?? 0) * (left.height ?? 0);
        const rightSize = (right.width ?? 0) * (right.height ?? 0);
        if (leftSize !== rightSize) {
          return rightSize - leftSize;
        }
        return (right.file_size ?? 0) - (left.file_size ?? 0);
      })[0];
    if (!largestPhoto) {
      return {
        input,
        inputImages: []
      };
    }
    const fileResponse = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "getFile"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        file_id: largestPhoto.file_id
      })
    });
    const filePayload = await parseApiResponse<TelegramGetFileResult>(fileResponse, "getFile");
    const filePath = filePayload.result?.file_path?.trim();
    if (!filePath) {
      return {
        input,
        inputImages: []
      };
    }

    const fileBytesResponse = await this.fetchImpl(buildFileUrl(this.apiBaseUrl, this.token, filePath), {
      method: "GET"
    });
    if (!fileBytesResponse.ok) {
      let bodyPreview = "";
      try {
        bodyPreview = truncateForLog(await fileBytesResponse.text());
      } catch {
        bodyPreview = "";
      }
      throw new Error(
        `Telegram file download failed status=${fileBytesResponse.status}${bodyPreview ? ` description=${bodyPreview}` : ""}`
      );
    }
    const fileBytes = Buffer.from(await fileBytesResponse.arrayBuffer());
    return {
      input,
      inputImages: [
        {
          mimeType: inferImageMimeType(filePath),
          dataBase64: fileBytes.toString("base64")
        }
      ]
    };
  }

  async sendMessage(
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
    }

    try {
      const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "sendMessage"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const apiPayload = await parseApiResponse<TelegramSendMessageResult>(response, "sendMessage");
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

  async editMessage(
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
    }

    try {
      const response = await this.fetchImpl(buildApiUrl(this.apiBaseUrl, this.token, "editMessageText"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      await parseApiResponse<Record<string, unknown>>(response, "editMessageText");
    } catch (error) {
      if (!parseMode || !allowFallback) {
        throw error;
      }
      await this.editMessage(chatId, messageId, stripTelegramHtml(text), undefined, false);
    }
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
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
    await parseApiResponse<Record<string, unknown>>(response, "sendChatAction");
  }
}
