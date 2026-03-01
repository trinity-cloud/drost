import { ProviderManager, type ProviderRouteSelection } from "../providers/manager.js";
import { AnthropicMessagesAdapter } from "../providers/anthropic.js";
import { CodexExecAdapter } from "../providers/codex-exec.js";
import { OpenAIResponsesAdapter } from "../providers/openai-responses.js";
import type { SessionMutationResult } from "../gateway.js";

export function ensureProviderManager(runtime: any): ProviderManager | null {
  if (runtime.providerManager) {
    return runtime.providerManager;
  }
  if (!runtime.config.providers) {
    return null;
  }
  const adapters = [
    new CodexExecAdapter(),
    new OpenAIResponsesAdapter(),
    new AnthropicMessagesAdapter(),
    ...(runtime.config.providers.adapters ?? [])
  ];
  runtime.providerManager = new ProviderManager({
    profiles: runtime.config.providers.profiles,
    adapters,
    failover: runtime.config.failover
  });
  return runtime.providerManager;
}

export function providerRouteMap(
  runtime: any
): Map<string, { id: string; primaryProviderId: string; fallbackProviderIds: string[] }> {
  const routes = new Map<string, { id: string; primaryProviderId: string; fallbackProviderIds: string[] }>();
  for (const route of runtime.config.providerRouter?.routes ?? []) {
    const routeId = route.id.trim();
    const primaryProviderId = route.primaryProviderId.trim();
    if (!routeId || !primaryProviderId) {
      continue;
    }
    routes.set(routeId, {
      id: routeId,
      primaryProviderId,
      fallbackProviderIds: (route.fallbackProviderIds ?? [])
        .map((providerId: string) => providerId.trim())
        .filter((providerId: string) => providerId.length > 0 && providerId !== primaryProviderId)
    });
  }
  return routes;
}

export function validateProviderRoutes(runtime: any): void {
  if (!(runtime.config.providerRouter?.enabled ?? false)) {
    return;
  }
  const routes = providerRouteMap(runtime);
  if (routes.size === 0) {
    runtime.degradedReasons.push("providerRouter.enabled=true but no valid routes are configured");
    runtime.state = "degraded";
    return;
  }
  const knownProviderIds = new Set((runtime.config.providers?.profiles ?? []).map((profile: { id: string }) => profile.id));
  for (const route of routes.values()) {
    if (!knownProviderIds.has(route.primaryProviderId)) {
      runtime.degradedReasons.push(
        `Provider route ${route.id} references unknown primary provider ${route.primaryProviderId}`
      );
      runtime.state = "degraded";
    }
    for (const fallbackProviderId of route.fallbackProviderIds) {
      if (!knownProviderIds.has(fallbackProviderId)) {
        runtime.degradedReasons.push(
          `Provider route ${route.id} references unknown fallback provider ${fallbackProviderId}`
        );
        runtime.state = "degraded";
      }
    }
  }
}

export function selectedRouteIdForSession(runtime: any, sessionId: string): string | null {
  const override = runtime.sessionProviderRouteOverrides.get(sessionId)?.trim();
  if (override) {
    return override;
  }
  const fromMetadata = ensureProviderManager(runtime)?.getSession(sessionId)?.metadata.providerRouteId?.trim();
  if (fromMetadata) {
    return fromMetadata;
  }
  const defaultRoute = runtime.config.providerRouter?.defaultRoute?.trim();
  return defaultRoute || null;
}

export function resolveProviderRouteSelection(runtime: any, sessionId: string): ProviderRouteSelection | null {
  const enabled = runtime.config.providerRouter?.enabled ?? false;
  if (!enabled) {
    return null;
  }
  const routeId = selectedRouteIdForSession(runtime, sessionId);
  if (!routeId) {
    return null;
  }
  const route = providerRouteMap(runtime).get(routeId);
  if (!route) {
    const message = `Unknown provider route: ${routeId}`;
    if (!runtime.degradedReasons.includes(message)) {
      runtime.degradedReasons.push(message);
    }
    runtime.state = "degraded";
    return null;
  }
  return {
    routeId: route.id,
    primaryProviderId: route.primaryProviderId,
    fallbackProviderIds: route.fallbackProviderIds
  };
}

export function listProviderRoutes(runtime: any): Array<{ id: string; primaryProviderId: string; fallbackProviderIds: string[] }> {
  return Array.from(providerRouteMap(runtime).values());
}

export function getSessionProviderRoute(runtime: any, sessionId: string): string | undefined {
  const manager = ensureProviderManager(runtime);
  const routeId =
    runtime.sessionProviderRouteOverrides.get(sessionId)?.trim() ??
    manager?.getSession(sessionId)?.metadata.providerRouteId?.trim();
  return routeId && routeId.length > 0 ? routeId : undefined;
}

export function setSessionProviderRoute(runtime: any, sessionId: string, routeId: string): SessionMutationResult {
  const normalizedSessionId = sessionId.trim();
  const normalizedRouteId = routeId.trim();
  if (!normalizedSessionId || !normalizedRouteId) {
    return {
      ok: false,
      message: "sessionId and routeId are required"
    };
  }
  const route = providerRouteMap(runtime).get(normalizedRouteId);
  if (!route) {
    return {
      ok: false,
      message: `Unknown provider route: ${normalizedRouteId}`
    };
  }
  if (!runtime.sessionExists(normalizedSessionId)) {
    return {
      ok: false,
      message: `Unknown session: ${normalizedSessionId}`
    };
  }
  runtime.ensureSession(normalizedSessionId);
  runtime.sessionProviderRouteOverrides.set(normalizedSessionId, normalizedRouteId);
  const manager = ensureProviderManager(runtime);
  manager?.updateSessionMetadata(normalizedSessionId, {
    providerRouteId: normalizedRouteId
  });
  runtime.persistSessionState(normalizedSessionId);
  runtime.emitRuntimeEvent("gateway.config.reloaded", {
    action: "session.provider_route",
    sessionId: normalizedSessionId,
    routeId: normalizedRouteId
  });
  return {
    ok: true,
    message: `Session ${normalizedSessionId} route set to ${normalizedRouteId}`,
    sessionId: normalizedSessionId
  };
}
