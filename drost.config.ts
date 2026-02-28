import { createTelegramChannel } from "./packages/channel-telegram/src/index.ts";

const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

export default {
  workspaceDir: ".",
  evolution: {
    enabled: true,
    mutableRoots: ["."],
    validation: {
      commands: ["pnpm -r --if-present build", "pnpm test"]
    },
    healthGate: {
      enabled: true,
      timeoutMs: 15000
    },
    rollbackOnFailure: true,
    strictMode: true
  },
  sessionStore: {
    enabled: true,
    directory: "./.drost/sessions"
  },
  authStorePath: "./.drost/auth-profiles.json",
  health: {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    path: "/healthz"
  },
  providers: {
    defaultSessionProvider: "openai-codex",
    startupProbe: {
      enabled: true,
      timeoutMs: 20000
    },
    profiles: [
      {
        id: "openai-codex",
        adapterId: "codex-exec",
        kind: "openai-codex",
        baseUrl: "https://api.openai.com",
        model: "gpt-5.3-codex",
        authProfileId: "openai-codex:default"
      },
      {
        id: "openai",
        adapterId: "openai-responses",
        kind: "openai",
        baseUrl: "https://api.openai.com",
        model: "gpt-5.3-codex",
        authProfileId: "openai:default"
      },
      {
        id: "anthropic",
        adapterId: "anthropic-messages",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
        authProfileId: "anthropic:default"
      },
      {
        id: "xai",
        adapterId: "openai-responses",
        kind: "openai-compatible",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4-1-fast-reasoning",
        authProfileId: "openai-compatible:xai"
      },
      {
        id: "local-openai-compatible",
        adapterId: "openai-responses",
        kind: "openai-compatible",
        baseUrl: "http://localhost:8000",
        model: "your-model-id",
        authProfileId: "openai-compatible:local"
      }
    ]
  },
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
