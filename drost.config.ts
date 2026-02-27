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
        model: "claude-opus-4-6",
        authProfileId: "anthropic:default"
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
  }
};
