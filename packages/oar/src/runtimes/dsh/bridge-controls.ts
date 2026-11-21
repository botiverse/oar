/** Native job ownership and session-scoped sandbox grants in the DSH process. */
export const dshControlSource = String.raw`
  const jobs = ctx.get("jobs");
  const sessions = ctx.get("sessions");
  const statSessionFile = async (sessionId) => {
    const snapshot = await persistence.stat(sessionId);
    const location = snapshot?.location;
    return typeof location?.path === "string" && location.path.length > 0 ? location.path : undefined;
  };
  const sessionFileOf = async (sessionId, flush = false) => {
    if (typeof persistence?.stat !== "function") { return undefined; }
    const existing = await statSessionFile(sessionId);
    if (existing !== undefined || !flush) { return existing; }
    const session = handles.get(sessionId)?.agent?.session;
    if (typeof session?.seq !== "number" || session.seq <= 0) { return undefined; }
    if (typeof sessions?.flush === "function") { await sessions.flush(session); }
    else if (typeof persistence.flush === "function") { await persistence.flush(); }
    return await statSessionFile(sessionId);
  };
  const configureDirectories = (agent, request) => {
    if (request.additionalDirectories?.length > 0) {
      const policy = agent.scope.ctx.get("sandboxPolicy");
      requireMethod(policy, "registerWritableRoot", "additionalDirectories");
      for (const directory of request.additionalDirectories) {
        const unregister = policy.registerWritableRoot(agent.session, directory);
        agent.scope.ctx.effect(() => unregister);
      }
    }
  };
  const configureTools = (agent, request) => {
    if (request.disallowedTools?.length > 0) {
      const tools = agent.scope?.ctx?.tools;
      requireMethod(tools, "restrict", "disallowedTools");
      requireMethod(tools, "get", "disallowedTools");
      requireMethod(agent.scope.ctx, "on", "disallowedTools");
      try { tools.restrict({ deny: request.disallowedTools }); }
      catch (error) { throw refusal("option_not_applied", String(error?.message ?? error), "disallowedTools"); }
      agent.scope.ctx.on("agent/created", ({ agent: created }) => {
        if (created !== agent) { return; }
        for (const name of request.disallowedTools) {
          if (tools.get(name, agent) !== undefined) {
            throw refusal("option_not_applied", "The native tool remains available: " + name, "disallowedTools");
          }
        }
      });
    }
  };

  const compacting = new Map();
  const sessionControls = {
    async compact(request) {
      const { agent } = owned(request.sessionId);
      const service = ctx.get("compaction");
      requireMethod(service, "compactNow", "manual compaction");
      if (agent.status !== "idle" || agent.inbox?.nextTurn?.length || admissions.has(agent) || compacting.has(agent)) throw refusal("busy", "DSH has pending input or an active operation");
      const controller = new AbortController();
      compacting.set(agent, controller);
      try { return { result: await service.compactNow(agent, controller.signal, request.commandId) }; }
      finally { compacting.delete(agent); }
    },
    cancelCompaction(request) {
      const { agent } = owned(request.sessionId);
      const controller = compacting.get(agent);
      if (!controller) throw refusal("busy", "No live native compaction target");
      controller.abort();
      return {};
    },
    async stopTask(request) {
      const { agent } = owned(request.sessionId);
      const owner = agent.session.id;
      const job = jobs.get(request.taskId, owner);
      if (job.owner !== owner || (job.kind !== "bash" && job.kind !== "pwsh")) {
        throw refusal("unsupported_task", "DSH can stop only a shell job owned by this session");
      }
      const result = jobs.kill(job.id, owner, "Stopped by host");
      if (result !== "requested") { throw refusal("job_finished", "DSH reports that this shell job already finished"); }
      const settled = await jobs.wait(job.id, 5000, owner);
      if (settled.status !== "killed") { throw refusal("job_not_killed", "DSH reported shell job status " + settled.status); }
      return { jobId: settled.id, status: settled.status };
    },
    async sessionFile(request) {
      owned(request.sessionId);
      const path = await sessionFileOf(request.sessionId, true);
      return { path: path ?? null };
    },
  };
`;
