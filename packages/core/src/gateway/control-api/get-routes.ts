export function handleControlGetRequest(params: {
  runtime: any;
  basePath: string;
  pathname: string;
  url: URL;
  response: any;
  startControlEventStream: () => void;
}): boolean {
  const { runtime, basePath, pathname, url, response } = params;

  if (pathname === `${basePath}/events`) {
    params.startControlEventStream();
    return true;
  }

  if (pathname === `${basePath}/status`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      status: runtime.getStatus(),
      loadedTools: runtime.listLoadedToolNames(),
      sessions: runtime.listSessionSnapshots().length,
      channels: runtime.listChannelAdapterIds(),
      continuity: runtime.listContinuityJobs(20),
      providerRoutes: runtime.listProviderRoutes(),
      orchestrationLanes: runtime.listOrchestrationLaneStatuses(),
      retention: runtime.getSessionRetentionStatus()
    });
    return true;
  }

  if (pathname === `${basePath}/sessions`) {
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, requestedLimit))
      : 50;
    runtime.writeControlJson(response, 200, {
      ok: true,
      sessions: runtime.listSessionSnapshots().slice(0, limit),
      total: runtime.listSessionSnapshots().length
    });
    return true;
  }

  if (pathname === `${basePath}/sessions/retention`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      retention: runtime.getSessionRetentionStatus()
    });
    return true;
  }

  if (pathname === `${basePath}/orchestration/lanes`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      lanes: runtime.listOrchestrationLaneStatuses()
    });
    return true;
  }

  const sessionDetailMatch = pathname.match(/^\/control\/v1\/sessions\/([^/]+)$/);
  if (sessionDetailMatch) {
    const sessionId = decodeURIComponent(sessionDetailMatch[1] ?? "");
    const record = runtime.exportSession(sessionId);
    if (!record) {
      runtime.writeControlJson(response, 404, {
        ok: false,
        error: "session_not_found",
        sessionId
      });
      return true;
    }
    runtime.writeControlJson(response, 200, {
      ok: true,
      session: record
    });
    return true;
  }

  if (pathname === `${basePath}/providers/status`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      providerProfiles: runtime.listProviderProfiles(),
      providerDiagnostics: runtime.providerDiagnostics,
      failover: runtime.getProviderFailoverStatus(),
      routes: runtime.listProviderRoutes()
    });
    return true;
  }

  if (pathname === `${basePath}/plugins/status`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      plugins: runtime.pluginRuntime?.getStatus() ?? {
        enabled: false,
        loaded: [],
        blocked: [],
        runtimeErrors: []
      }
    });
    return true;
  }

  if (pathname === `${basePath}/skills`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      skills: {
        status: runtime.skillRuntime?.getStatus() ?? {
          enabled: false,
          roots: [],
          discovered: 0,
          allowed: 0,
          blocked: [],
          injectionMode: "off",
          maxInjected: 0
        },
        allowed: runtime.skillRuntime?.listAllowed() ?? [],
        blocked: runtime.skillRuntime?.listBlocked() ?? []
      }
    });
    return true;
  }

  if (pathname === `${basePath}/subagents/jobs`) {
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, requestedLimit))
      : 50;
    const jobs = runtime.listSubagentJobs({
      sessionId: sessionId?.trim() || undefined,
      limit
    });
    runtime.writeControlJson(response, 200, {
      ok: true,
      jobs,
      total: jobs.length
    });
    return true;
  }

  const subagentJobMatch = pathname.match(/^\/control\/v1\/subagents\/jobs\/([^/]+)$/);
  if (subagentJobMatch) {
    const jobId = decodeURIComponent(subagentJobMatch[1] ?? "");
    const job = runtime.getSubagentJob(jobId);
    if (!job) {
      runtime.writeControlJson(response, 404, {
        ok: false,
        error: "subagent_job_not_found",
        jobId
      });
      return true;
    }
    runtime.writeControlJson(response, 200, {
      ok: true,
      job
    });
    return true;
  }

  const subagentLogsMatch = pathname.match(/^\/control\/v1\/subagents\/jobs\/([^/]+)\/logs$/);
  if (subagentLogsMatch) {
    const jobId = decodeURIComponent(subagentLogsMatch[1] ?? "");
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(1000, requestedLimit))
      : 200;
    const logs = runtime.readSubagentLogs(jobId, limit);
    runtime.writeControlJson(response, 200, {
      ok: true,
      jobId,
      logs
    });
    return true;
  }

  if (pathname === `${basePath}/optional/status`) {
    runtime.writeControlJson(response, 200, {
      ok: true,
      modules: runtime.optionalModuleRuntime?.doctor() ?? []
    });
    return true;
  }

  return false;
}
