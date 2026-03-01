export function resolveToolProviderId(runtime: any, sessionId: string, overrideProviderId?: string): string {
  if (overrideProviderId && overrideProviderId.trim().length > 0) {
    return overrideProviderId;
  }
  const manager = runtime.ensureProviderManager();
  if (!manager) {
    return "local";
  }
  const session = manager.getSession(sessionId);
  if (!session) {
    return "local";
  }
  return session.activeProviderId;
}

export function isToolAllowed(runtime: any, toolName: string): { allowed: boolean; reason?: string } {
  const policy = runtime.config.toolPolicy;
  if (!policy) {
    return {
      allowed: true
    };
  }

  const denied = new Set((policy.deniedTools ?? []).map((name: string) => name.trim()).filter((name: string) => name.length > 0));
  const allowed =
    policy.allowedTools && policy.allowedTools.length > 0
      ? new Set(policy.allowedTools.map((name: string) => name.trim()).filter((name: string) => name.length > 0))
      : null;

  if (denied.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" denied by toolPolicy.deniedTools`
    };
  }
  if (allowed && !allowed.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" not in toolPolicy.allowedTools`
    };
  }

  const profile = policy.profile ?? "balanced";
  if (profile === "strict") {
    const strictDefaultDenied = new Set(["shell", "web"]);
    if (strictDefaultDenied.has(toolName) && !(allowed?.has(toolName) ?? false)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" denied by strict tool policy profile`
      };
    }
  }

  return {
    allowed: true
  };
}
