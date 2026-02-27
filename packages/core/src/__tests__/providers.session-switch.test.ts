import { describe, expect, it } from "vitest";
import type { ProviderAdapter, ProviderProbeContext, ProviderProbeResult, ProviderProfile, ProviderTurnRequest } from "../providers/types.js";
import type { AuthStore } from "../auth/store.js";
import { ProviderManager } from "../providers/manager.js";

class Deferred {
  promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeAdapter implements ProviderAdapter {
  readonly id = "fake";

  readonly requestedProviders: string[] = [];

  private readonly deferred = new Deferred();

  releaseFirstTurn(): void {
    this.deferred.resolve();
  }

  async probe(profile: ProviderProfile, _context: ProviderProbeContext): Promise<ProviderProbeResult> {
    return {
      providerId: profile.id,
      ok: true,
      code: "ok",
      message: "ok"
    };
  }

  async runTurn(request: ProviderTurnRequest): Promise<void> {
    this.requestedProviders.push(request.providerId);

    if (this.requestedProviders.length === 1) {
      await this.deferred.promise;
    }

    request.emit({
      type: "response.delta",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: `reply:${request.providerId}`
      }
    });

    request.emit({
      type: "response.completed",
      sessionId: request.sessionId,
      providerId: request.providerId,
      timestamp: new Date().toISOString(),
      payload: {
        text: `reply:${request.providerId}`
      }
    });
  }
}

function authStore(): AuthStore {
  return {
    version: 1,
    profiles: {
      "auth:a": {
        id: "auth:a",
        provider: "openai-compatible",
        credential: {
          type: "api_key",
          value: "token-a"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      "auth:b": {
        id: "auth:b",
        provider: "openai-compatible",
        credential: {
          type: "api_key",
          value: "token-b"
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  };
}

describe("provider session switching", () => {
  it("keeps session history and applies provider switch on next turn", async () => {
    const adapter = new FakeAdapter();
    const manager = new ProviderManager({
      profiles: [
        {
          id: "provider-a",
          adapterId: "fake",
          kind: "openai-compatible",
          baseUrl: "https://example.com",
          model: "demo",
          authProfileId: "auth:a"
        },
        {
          id: "provider-b",
          adapterId: "fake",
          kind: "openai-compatible",
          baseUrl: "https://example.com",
          model: "demo",
          authProfileId: "auth:b"
        }
      ],
      adapters: [adapter]
    });

    manager.ensureSession("s-1", "provider-a");

    const events: string[] = [];
    const firstTurn = manager.runTurn({
      sessionId: "s-1",
      input: "hello",
      authStore: authStore(),
      onEvent: (event) => {
        events.push(event.type);
      }
    });

    manager.queueProviderSwitch("s-1", "provider-b");

    const duringTurn = manager.getSession("s-1");
    expect(duringTurn?.activeProviderId).toBe("provider-a");
    expect(duringTurn?.pendingProviderId).toBe("provider-b");

    adapter.releaseFirstTurn();
    await firstTurn;

    const afterFirst = manager.getSession("s-1");
    expect(afterFirst?.activeProviderId).toBe("provider-a");
    expect(afterFirst?.history.length).toBe(2);

    await manager.runTurn({
      sessionId: "s-1",
      input: "continue",
      authStore: authStore(),
      onEvent: () => {
        // no-op
      }
    });

    const afterSecond = manager.getSession("s-1");
    expect(afterSecond?.activeProviderId).toBe("provider-b");
    expect(afterSecond?.history.length).toBe(4);

    expect(adapter.requestedProviders).toEqual(["provider-a", "provider-b"]);
    expect(events).toContain("response.delta");
    expect(events).toContain("response.completed");
  });
});
