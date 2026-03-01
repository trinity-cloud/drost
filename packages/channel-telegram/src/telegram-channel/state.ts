import fs from "node:fs";
import path from "node:path";
import type { TelegramChannelState } from "./types.js";
import { toError } from "./types.js";

export class TelegramStateStore {
  offset = 0;
  private lockFd: number | null = null;
  readonly lastMessageIdsByChat = new Map<string, number>();
  readonly sessionPrefixByChat = new Map<string, string>();

  constructor(
    private readonly stateFilePath: string,
    private readonly lockFilePath: string,
    private readonly persistState: boolean
  ) {}

  private ensureStateDirectoryExists(): void {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });
  }

  acquirePollLock(): void {
    if (!this.persistState || this.lockFd !== null) {
      return;
    }
    this.ensureStateDirectoryExists();
    try {
      this.lockFd = this.openPollLockFile();
      fs.writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
    } catch {
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

  releasePollLock(): void {
    if (this.lockFd === null) {
      return;
    }
    try {
      fs.closeSync(this.lockFd);
    } catch {
      // ignore close errors during shutdown
    }
    this.lockFd = null;
    try {
      fs.unlinkSync(this.lockFilePath);
    } catch {
      // ignore stale/missing lock cleanup failures
    }
  }

  loadState(): void {
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
      throw new Error(`Failed to parse telegram state file ${this.stateFilePath}: ${toError(error).message}`);
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

    this.sessionPrefixByChat.clear();
    if (record.sessionPrefixByChat && typeof record.sessionPrefixByChat === "object") {
      for (const [chatId, value] of Object.entries(record.sessionPrefixByChat)) {
        if (typeof value === "string" && value.length > 0) {
          this.sessionPrefixByChat.set(chatId, value);
        }
      }
    }
  }

  persistStateToDisk(): void {
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

    const sessionPrefixByChat: Record<string, string> = {};
    for (const [chatId, value] of this.sessionPrefixByChat.entries()) {
      if (value) {
        sessionPrefixByChat[chatId] = value;
      }
    }

    const state: TelegramChannelState = {
      version: 1,
      offset: Math.max(0, Math.floor(this.offset)),
      lastMessageIdsByChat,
      sessionPrefixByChat,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  wasMessageAlreadyProcessed(chatId: number, messageId: number): boolean {
    const key = String(chatId);
    const last = this.lastMessageIdsByChat.get(key);
    return typeof last === "number" && Number.isFinite(last) && messageId <= last;
  }

  markMessageProcessed(chatId: number, messageId: number): void {
    const key = String(chatId);
    const last = this.lastMessageIdsByChat.get(key) ?? 0;
    if (messageId > last) {
      this.lastMessageIdsByChat.set(key, messageId);
    }
  }

  getSessionPrefix(chatId: number): string | undefined {
    return this.sessionPrefixByChat.get(String(chatId));
  }
}
