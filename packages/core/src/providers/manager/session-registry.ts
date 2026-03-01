import type { SessionMetadata } from "../../sessions.js";
import type { ChatMessage } from "../../types.js";
import type { ProviderSessionState } from "../types.js";
import { createSessionMetadata, nowIso } from "./metadata.js";

export class ProviderSessionRegistry {
  private readonly sessions = new Map<string, ProviderSessionState>();

  constructor(private readonly profileExists: (providerId: string) => boolean) {}

  listSessions(): ProviderSessionState[] {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      history: [...session.history],
      activeProviderId: session.activeProviderId,
      pendingProviderId: session.pendingProviderId,
      turnInProgress: session.turnInProgress,
      metadata: {
        ...session.metadata
      }
    }));
  }

  getSession(sessionId: string): ProviderSessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  hydrateSession(params: {
    sessionId: string;
    history: ChatMessage[];
    activeProviderId?: string;
    pendingProviderId?: string;
    metadata?: Partial<SessionMetadata>;
  }): ProviderSessionState {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    if (params.activeProviderId && !this.profileExists(params.activeProviderId)) {
      throw new Error(`Unknown provider profile: ${params.activeProviderId}`);
    }
    if (params.pendingProviderId && !this.profileExists(params.pendingProviderId)) {
      throw new Error(`Unknown provider profile: ${params.pendingProviderId}`);
    }

    session.history = [...params.history];
    if (params.activeProviderId) {
      session.activeProviderId = params.activeProviderId;
    }
    session.pendingProviderId = params.pendingProviderId;
    session.metadata = createSessionMetadata({
      ...session.metadata,
      ...params.metadata
    });
    return session;
  }

  ensureSession(
    sessionId: string,
    initialProviderId: string,
    metadata?: Partial<SessionMetadata>
  ): ProviderSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (metadata) {
        existing.metadata = createSessionMetadata({
          ...existing.metadata,
          ...metadata
        });
      }
      return existing;
    }

    if (!this.profileExists(initialProviderId)) {
      throw new Error(`Unknown initial provider profile: ${initialProviderId}`);
    }

    const created: ProviderSessionState = {
      sessionId,
      history: [],
      activeProviderId: initialProviderId,
      turnInProgress: false,
      metadata: createSessionMetadata(metadata)
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    if (session.turnInProgress) {
      throw new Error(`Cannot delete session in progress: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
    return true;
  }

  renameSession(params: {
    fromSessionId: string;
    toSessionId: string;
  }): ProviderSessionState {
    const from = params.fromSessionId;
    const to = params.toSessionId;
    const source = this.sessions.get(from);
    if (!source) {
      throw new Error(`Unknown session: ${from}`);
    }
    if (source.turnInProgress) {
      throw new Error(`Cannot rename session in progress: ${from}`);
    }
    if (this.sessions.has(to)) {
      throw new Error(`Session already exists: ${to}`);
    }

    this.sessions.delete(from);
    const renamed: ProviderSessionState = {
      ...source,
      sessionId: to,
      metadata: {
        ...source.metadata,
        lastActivityAt: nowIso()
      }
    };
    this.sessions.set(to, renamed);
    return renamed;
  }

  updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): ProviderSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    session.metadata = createSessionMetadata({
      ...session.metadata,
      ...metadata
    });
    return session;
  }

  getSessionHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return [...session.history];
  }

  queueProviderSwitch(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (!this.profileExists(providerId)) {
      throw new Error(`Unknown provider profile: ${providerId}`);
    }
    session.pendingProviderId = providerId;
  }
}
