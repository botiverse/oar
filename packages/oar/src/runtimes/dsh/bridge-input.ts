/** Persist incoming bytes in DSH's attachment store and send its durable references in the user message. */
export const dshInputSource = String.raw`
  const routes = new WeakMap();
  const admissions = new WeakMap();
  const pendingQueues = new WeakMap();
  const supportedMedia = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  async function imageTypes(agent) {
    const route = agent.model?.current?.() ?? routes.get(agent);
    const attachments = ctx.get("attachments");
    const llm = ctx.get("llm");
    if (!route?.provider || !route.model || typeof attachments?.saveImages !== "function" || typeof llm?.resolveModelInfo !== "function") return [];
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model);
      return info.inputModalities?.includes("image") ? supportedMedia.filter(type => attachments.imageLimits?.mediaTypes?.includes(type)) : [];
    } catch { return []; }
  }
  const submit = async (agent, method, request, pending) => {
    const isImage = request.images?.length > 0;
    const verify = () => {
      if (compacting.has(agent)) throw refusal("busy", "DSH is compacting this session");
      if (method === "prompt" && agent.status !== "idle") throw refusal("busy", "busy");
      if (method === "steer" && agent.status === "idle") throw refusal("no_active_turn", "no active turn");
    };
    const action = method === "steer" ? "steer" : "followup";
    requireMethod(agent, action, method);
    verify();
    const content = request.text.length > 0 || !isImage ? [{ type: "text", text: request.text }] : [];
    if (isImage) {
      const types = await imageTypes(agent);
      if (request.images.some(image => !types.includes(image.mediaType))) throw refusal("image_unsupported", "This DSH model or attachment store does not accept the requested image type");
      const refs = await ctx.get("attachments").saveImages(request.images.map(image => ({ data: Buffer.from(image.data, "base64"), mediaType: image.mediaType })));
      if (refs.length !== request.images.length) throw refusal("native_attachment_error", "DSH did not store every submitted image");
      for (const attachment of refs) content.push({ type: "image", attachment });
      verify();
    }
    const messageId = pending?.id ?? request.inputId ?? randomUUID();
    if (pending?.withdrawn === true) { pending.intercepted = true; return { messageId }; }
    const message = Object.freeze({ id: messageId, role: "user", content: Object.freeze(content), source: Object.freeze({ kind: "user" }) });
    cause = method === "prompt" ? "prompt" : undefined;
    try { agent[action](message); } finally { cause = undefined; }
    return { messageId: message.id };
  };
  const admitInput = (method, request) => {
    const { agent } = owned(request.sessionId);
    let pending;
    if (method === "queue") {
      requireMethod(agent, "followup", "queue");
      let settledResolve;
      const settled = new Promise(resolve => { settledResolve = resolve; });
      pending = { id: request.inputId ?? randomUUID(), withdrawn: false, intercepted: false, settled, resolve: settledResolve };
      const list = pendingQueues.get(agent) ?? [];
      list.push(pending);
      pendingQueues.set(agent, list);
    }
    const removePending = () => {
      if (pending === undefined) return;
      const list = pendingQueues.get(agent);
      if (list !== undefined) {
        const index = list.indexOf(pending);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) pendingQueues.delete(agent);
      }
      pending.resolve(pending.intercepted);
    };
    const previous = admissions.get(agent);
    const run = async () => {
      try { const value = await submit(agent, method, request, pending); removePending(); return value; }
      catch (error) { removePending(); throw error; }
    };
    const next = previous === undefined ? run() : previous.then(run, run);
    admissions.set(agent, next);
    const clear = () => { if (admissions.get(agent) === next) admissions.delete(agent); };
    next.then(clear, clear);
    return next;
  };
`;
