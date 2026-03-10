# Telegram Integration

Drost is Telegram-native. The Telegram channel handles all messaging I/O including text, images, media groups, session management, and real-time streaming updates.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram.
2. Set the bot token:

```env
DROST_TELEGRAM_BOT_TOKEN=your-bot-token
```

3. (Optional) Restrict access to specific users:

```env
DROST_TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

If `DROST_TELEGRAM_ALLOWED_USER_IDS` is empty, all users can interact with the bot.

## Connection Modes

### Polling (default)

No extra configuration needed. Drost polls Telegram for updates. Best for local development and personal deployments.

### Webhook

For production or when running behind a reverse proxy:

```env
DROST_TELEGRAM_WEBHOOK_URL=https://your-domain.com
DROST_TELEGRAM_WEBHOOK_PATH=/webhook/telegram
DROST_TELEGRAM_WEBHOOK_SECRET=your-secret-token
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show status and available commands |
| `/help` | List all commands |
| `/new [title]` | Create a new session and switch to it |
| `/sessions` | List all sessions |
| `/use <id\|index>` | Switch to a different session |
| `/current` | Show active session info |
| `/reset` | Clear the active session transcript |

## Sessions

Drost supports multiple concurrent sessions per chat. When you send your first message, a timestamped session is auto-created. Use `/new` to start a fresh session — the previous one is summarized for continuity.

Sessions are identified by a session key format: `tg:<chat_id>:<session_id>`.

## Real-Time Streaming

When the agent is working, Telegram shows live updates:

- **Status updates**: "Thinking...", "Using tools: memory_search, web_fetch", "Running tool: shell_execute"
- **Streaming text**: The agent's response streams into the working message as it's generated.
- **Multi-segment**: When the agent uses tools mid-response, the previous text segment is finalized and a new working message is created.

All updates use rate-limited message edits to stay within Telegram's API limits.

## Vision / Image Support

Drost supports multimodal input across all providers:

- **Single photo** with caption
- **Document** (image files) with caption
- **Media group albums** — multiple photos are bundled and sent as a single multi-image turn

Images are:
1. Downloaded from Telegram.
2. Saved to `~/.drost/attachments/telegram/`.
3. Base64-encoded and included as image content parts in the provider request.
4. Subject to `DROST_VISION_MAX_INLINE_IMAGE_BYTES` (default: 5MB) — images exceeding this are referenced by path only.

## Message Rendering

Agent responses are rendered from Markdown to Telegram HTML:

- Bold, italic, code, pre blocks, links are converted.
- Long messages are split at 4000 characters (Telegram limit) with smart boundary detection.
- If HTML rendering fails, falls back to plain text.
