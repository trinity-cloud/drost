import type { ProviderProfile } from "../types.js";
import type { ProviderFailureClass } from "./failure.js";
import { nowIso } from "./metadata.js";

export interface ProviderFailoverConfig {
  enabled?: boolean;
  chain?: string[];
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  authCooldownSeconds?: number;
  rateLimitCooldownSeconds?: number;
  serverErrorCooldownSeconds?: number;
}

export interface ProviderFailoverStatus {
  enabled: boolean;
  maxRetries: number;
  chain: string[];
  providers: Array<{
    providerId: string;
    inCooldown: boolean;
    remainingCooldownSeconds: number;
    lastFailureClass?: ProviderFailureClass;
    lastFailureMessage?: string;
    lastFailureAt?: string;
  }>;
}

interface NormalizedFailoverConfig {
  enabled: boolean;
  chain: string[];
  maxRetries: number;
  retryDelayMs: number;
  backoffMultiplier: number;
  authCooldownSeconds: number;
  rateLimitCooldownSeconds: number;
  serverErrorCooldownSeconds: number;
}

function normalizeFailoverConfig(config: ProviderFailoverConfig | undefined): NormalizedFailoverConfig {
  return {
    enabled: config?.enabled ?? false,
    chain: [...(config?.chain ?? [])],
    maxRetries: Math.max(1, config?.maxRetries ?? 3),
    retryDelayMs: Math.max(0, config?.retryDelayMs ?? 250),
    backoffMultiplier: Math.max(1, config?.backoffMultiplier ?? 1.5),
    authCooldownSeconds: Math.max(0, config?.authCooldownSeconds ?? 900),
    rateLimitCooldownSeconds: Math.max(0, config?.rateLimitCooldownSeconds ?? 60),
    serverErrorCooldownSeconds: Math.max(0, config?.serverErrorCooldownSeconds ?? 15)
  };
}

export class ProviderFailoverState {
  private readonly config: NormalizedFailoverConfig;
  private readonly providerCooldownUntil = new Map<string, number>();
  private readonly providerFailures = new Map<string, {
    failureClass: ProviderFailureClass;
    message: string;
    timestamp: string;
  }>();

  constructor(config?: ProviderFailoverConfig) {
    this.config = normalizeFailoverConfig(config);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getRetryDelayMs(): number {
    return this.config.retryDelayMs;
  }

  getBackoffMultiplier(): number {
    return this.config.backoffMultiplier;
  }

  getMaxRetries(): number {
    return this.config.maxRetries;
  }

  private nowMs(): number {
    return Date.now();
  }

  remainingCooldownSeconds(providerId: string): number {
    const until = this.providerCooldownUntil.get(providerId);
    if (!until) {
      return 0;
    }
    return Math.max(0, Math.ceil((until - this.nowMs()) / 1000));
  }

  private inCooldown(providerId: string): boolean {
    return this.remainingCooldownSeconds(providerId) > 0;
  }

  private cooldownSecondsForClass(failureClass: ProviderFailureClass): number {
    if (failureClass === "auth" || failureClass === "permission") {
      return this.config.authCooldownSeconds;
    }
    if (failureClass === "rate_limit") {
      return this.config.rateLimitCooldownSeconds;
    }
    if (failureClass === "server_error") {
      return this.config.serverErrorCooldownSeconds;
    }
    return 0;
  }

  recordProviderFailure(params: {
    providerId: string;
    failureClass: ProviderFailureClass;
    message: string;
  }): void {
    const cooldownSeconds = this.cooldownSecondsForClass(params.failureClass);
    if (cooldownSeconds > 0) {
      this.providerCooldownUntil.set(params.providerId, this.nowMs() + cooldownSeconds * 1000);
    }
    this.providerFailures.set(params.providerId, {
      failureClass: params.failureClass,
      message: params.message,
      timestamp: nowIso()
    });
  }

  resolveCandidates(primaryProviderId: string, fallbackProviderIds?: string[]): string[] {
    const chain = [primaryProviderId];
    if (this.config.enabled) {
      for (const providerId of fallbackProviderIds ?? []) {
        const normalized = providerId.trim();
        if (!normalized || normalized === primaryProviderId) {
          continue;
        }
        chain.push(normalized);
      }
      for (const providerId of this.config.chain) {
        const normalized = providerId.trim();
        if (!normalized || normalized === primaryProviderId) {
          continue;
        }
        chain.push(normalized);
      }
    }

    const unique = Array.from(new Set(chain));
    const preferred = unique.filter((providerId) => !this.inCooldown(providerId));
    const cooled = unique.filter((providerId) => this.inCooldown(providerId));
    const ordered = [...preferred, ...cooled];
    return ordered.slice(0, Math.max(1, this.config.maxRetries));
  }

  getStatus(profiles: ProviderProfile[]): ProviderFailoverStatus {
    return {
      enabled: this.config.enabled,
      maxRetries: this.config.maxRetries,
      chain: [...this.config.chain],
      providers: profiles.map((profile) => {
        const failure = this.providerFailures.get(profile.id);
        return {
          providerId: profile.id,
          inCooldown: this.inCooldown(profile.id),
          remainingCooldownSeconds: this.remainingCooldownSeconds(profile.id),
          lastFailureClass: failure?.failureClass,
          lastFailureMessage: failure?.message,
          lastFailureAt: failure?.timestamp
        };
      })
    };
  }
}
