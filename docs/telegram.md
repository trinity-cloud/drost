# Telegram Channel Setup

This repo now includes a Telegram channel adapter package:

- `packages/channel-telegram`

Use it to let Telegram chats drive the same runtime/session system used by TUI.

## 1) Add Bot Credentials to `.env`

At repo root, create or edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:your-bot-token
TELEGRAM_WORKSPACE_ID=main
TELEGRAM_POLL_INTERVAL_MS=1000
```

Optional:

```bash
# Useful for tests or proxies
TELEGRAM_API_BASE_URL=https://api.telegram.org
```

Notes:

- `.env` and `.env.local` are auto-loaded by CLI config resolution.
- Shell-exported env vars take precedence over `.env` file values.

## 2) Wire Telegram Channel in `drost.config.ts`

```ts
import { createTelegramChannel } from "./packages/channel-telegram/src/index.ts";

const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

export default {
  // ...existing config...
  channels: telegramToken
    ? [
        createTelegramChannel({
          token: telegramToken,
          workspaceId: process.env.TELEGRAM_WORKSPACE_ID || "main",
          pollIntervalMs: Number.parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS || "1000", 10),
          apiBaseUrl: process.env.TELEGRAM_API_BASE_URL
        })
      ]
    : []
};
```

## 3) Start Runtime

```bash
drost start
```

If configured correctly:

- gateway emits `channel.connected` for `telegram`
- Telegram inbound text messages trigger gateway turns
- bot sends Telegram `typing` chat actions while generating
- assistant replies stream via message updates (`sendMessage` + `editMessageText`) when deltas are emitted

## 4) Live Smoke Checklist

1. Send a plain text message to your bot in Telegram.
2. Confirm a response is returned in Telegram.
3. In TUI, confirm session list includes a `session:telegram:...` entry.
4. Restart runtime and re-send a message; confirm session continuity.
