import type { SessionStoreConfig } from "../../config.js";
import type { ChannelSessionMappingOptions } from "../../session-mapping.js";

export async function handleControlPostRequest(params: {
  runtime: any;
  basePath: string;
  pathname: string;
  body: Record<string, unknown>;
  response: any;
}): Promise<boolean> {
  const { runtime, basePath, pathname, body, response } = params;

  if (pathname === `${basePath}/sessions`) {
    const channel = typeof body.channel === "string" ? body.channel : undefined;
    const title = typeof body.title === "string" ? body.title : undefined;
    const fromSessionId = typeof body.fromSessionId === "string" ? body.fromSessionId : undefined;
    const providerRouteId = typeof body.providerRouteId === "string" ? body.providerRouteId.trim() : "";
    const sessionId = runtime.createSession({
      channel,
      title,
      fromSessionId
    });
    if (providerRouteId) {
      runtime.setSessionProviderRoute(sessionId, providerRouteId);
    }
    runtime.writeControlJson(response, 200, {
      ok: true,
      sessionId
    });
    return true;
  }

  if (pathname === `${basePath}/sessions/prune`) {
    const policyOverride =
      body.policy && typeof body.policy === "object"
        ? (body.policy as SessionStoreConfig["retention"])
        : undefined;
    const prune = runtime.pruneSessions({
      dryRun: body.dryRun === true,
      policyOverride
    });
    runtime.writeControlJson(response, 200, {
      ok: true,
      prune
    });
    return true;
  }

  const switchMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/switch$/);
  if (switchMatch) {
    const targetSessionId = decodeURIComponent(switchMatch[1] ?? "");
    const identityRaw = body.identity;
    if (!identityRaw || typeof identityRaw !== "object") {
      runtime.writeControlJson(response, 400, {
        ok: false,
        error: "identity object is required"
      });
      return true;
    }
    const identityRecord = identityRaw as Record<string, unknown>;
    if (typeof identityRecord.channel !== "string") {
      runtime.writeControlJson(response, 400, {
        ok: false,
        error: "identity.channel is required"
      });
      return true;
    }
    const switchResult = runtime.switchChannelSession({
      identity: {
        channel: identityRecord.channel,
        workspaceId:
          typeof identityRecord.workspaceId === "string" ? identityRecord.workspaceId : undefined,
        chatId: typeof identityRecord.chatId === "string" ? identityRecord.chatId : undefined,
        userId: typeof identityRecord.userId === "string" ? identityRecord.userId : undefined,
        threadId: typeof identityRecord.threadId === "string" ? identityRecord.threadId : undefined
      },
      mapping:
        body.mapping && typeof body.mapping === "object"
          ? (body.mapping as ChannelSessionMappingOptions)
          : undefined,
      sessionId: targetSessionId,
      title: typeof body.title === "string" ? body.title : undefined
    });
    runtime.writeControlJson(response, switchResult.ok ? 200 : 400, {
      ok: switchResult.ok,
      message: switchResult.message,
      sessionId: switchResult.sessionId
    });
    return true;
  }

  const routeMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/route$/);
  if (routeMatch) {
    const targetSessionId = decodeURIComponent(routeMatch[1] ?? "");
    const routeId = typeof body.routeId === "string" ? body.routeId : "";
    const result = runtime.setSessionProviderRoute(targetSessionId, routeId);
    runtime.writeControlJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      message: result.message,
      sessionId: result.sessionId
    });
    return true;
  }

  const sessionSkillsMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)\/skills$/);
  if (sessionSkillsMatch) {
    const targetSessionId = decodeURIComponent(sessionSkillsMatch[1] ?? "");
    const hasMode = Object.prototype.hasOwnProperty.call(body, "injectionMode");
    let requestedMode: "off" | "all" | "relevant" | undefined;
    if (hasMode) {
      if (body.injectionMode === null) {
        requestedMode = undefined;
      } else if (
        body.injectionMode === "off" ||
        body.injectionMode === "all" ||
        body.injectionMode === "relevant"
      ) {
        requestedMode = body.injectionMode;
      } else {
        runtime.writeControlJson(response, 400, {
          ok: false,
          error: "injectionMode must be one of off|all|relevant|null"
        });
        return true;
      }
    }
    const result = runtime.setSessionSkillInjectionMode(targetSessionId, requestedMode);
    runtime.writeControlJson(response, result.ok ? 200 : 400, {
      ok: result.ok,
      message: result.message,
      sessionId: result.sessionId,
      injectionMode: result.ok ? runtime.getSessionSkillInjectionMode(targetSessionId) : undefined
    });
    return true;
  }

  if (pathname === `${basePath}/subagents/start`) {
    if (!runtime.subagentManager) {
      runtime.writeControlJson(response, 400, {
        ok: false,
        error: "subagents_disabled"
      });
      return true;
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const input = typeof body.input === "string" ? body.input : "";
    const providerId = typeof body.providerId === "string" ? body.providerId : undefined;
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
    const started = runtime.subagentManager.startJob({
      sessionId,
      input,
      providerId,
      timeoutMs
    });
    runtime.writeControlJson(response, started.ok ? 200 : 400, {
      ok: started.ok,
      message: started.message,
      job: started.job
    });
    return true;
  }

  const subagentCancelMatch = pathname.match(/^\/control\/v1\/subagents\/jobs\/([^/]+)\/cancel$/);
  if (subagentCancelMatch) {
    const jobId = decodeURIComponent(subagentCancelMatch[1] ?? "");
    const cancelled = runtime.cancelSubagentJob(jobId);
    runtime.writeControlJson(response, cancelled.ok ? 200 : 400, {
      ok: cancelled.ok,
      message: cancelled.message,
      job: cancelled.job
    });
    return true;
  }

  if (pathname === `${basePath}/backup/create`) {
    const outputDirectory = typeof body.outputDirectory === "string" ? body.outputDirectory : undefined;
    const created = runtime.optionalModuleRuntime?.createBackup({
      outputDirectory
    }) ?? {
      ok: false,
      message: "Optional modules runtime unavailable"
    };
    runtime.writeControlJson(response, created.ok ? 200 : 400, {
      ok: created.ok,
      message: created.message,
      backupPath: created.backupPath
    });
    return true;
  }

  if (pathname === `${basePath}/backup/restore`) {
    const backupPath = typeof body.backupPath === "string" ? body.backupPath : "";
    const restored = runtime.optionalModuleRuntime?.restoreBackup({
      backupPath
    }) ?? {
      ok: false,
      message: "Optional modules runtime unavailable"
    };
    runtime.writeControlJson(response, restored.ok ? 200 : 400, {
      ok: restored.ok,
      message: restored.message
    });
    return true;
  }

  if (pathname === `${basePath}/chat/send`) {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const input = typeof body.input === "string" ? body.input : "";
    if (!sessionId || !input) {
      runtime.writeControlJson(response, 400, {
        ok: false,
        error: "sessionId and input are required"
      });
      return true;
    }
    const includeEvents = body.includeEvents === true;
    const events: unknown[] = [];
    runtime.ensureSession(sessionId);
    await runtime.runSessionTurn({
      sessionId,
      input,
      onEvent: (event: unknown) => {
        if (includeEvents) {
          events.push(event);
        }
      }
    });
    const history = runtime.getSessionHistory(sessionId);
    const responseText =
      history
        .filter((message: { role: string }) => message.role === "assistant")
        .at(-1)?.content ?? "";
    const sessionState = runtime.getSessionState(sessionId);
    runtime.writeControlJson(response, 200, {
      ok: true,
      sessionId,
      providerId: sessionState?.activeProviderId,
      response: responseText,
      events: includeEvents ? events : undefined
    });
    return true;
  }

  if (pathname === `${basePath}/runtime/restart`) {
    const restart = await runtime.requestRestart({
      intent:
        body.intent === "manual" ||
        body.intent === "self_mod" ||
        body.intent === "config_change" ||
        body.intent === "signal"
          ? body.intent
          : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      providerId: typeof body.providerId === "string" ? body.providerId : undefined,
      dryRun: body.dryRun === true
    });
    if (restart && typeof restart === "object" && "ok" in restart) {
      runtime.writeControlJson(response, restart.ok ? 200 : 400, {
        ok: restart.ok,
        code: restart.code,
        message: restart.message,
        intent: restart.intent,
        dryRun: restart.dryRun
      });
    } else {
      runtime.writeControlJson(response, 202, {
        ok: true,
        message: "restart_triggered"
      });
    }
    return true;
  }

  return false;
}
