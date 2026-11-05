/** Revision of the internal transport between this source and `control.ts`. Both ship together; it is not a public protocol. */
export const DSH_BRIDGE_PROTOCOL = 1;

/**
 * The plugin DSH loads into its own process. It reaches DSH only through the
 * services the running process injects, so it imports no DSH package (a package
 * outside a profile cannot resolve them, and `tests/dsh/bridge.test.ts` greps
 * this text). Kept as source so a single-file host can write it to a private
 * directory without its own source tree. The vendor suite runs this exact text.
 *
 * Frames on stdout: `ready`, then `native` and `response` frames; `startup-error`
 * when the loader barrier fails (never an empty inventory); `protocol-error` for
 * a line that is not a command. A `native` frame carries the runtime's payload
 * unchanged, with only routing fields beside it.
 */
export const dshBridgeSource = String.raw`import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const name = "oar-dsh-bridge";

const PROTOCOL = ${String(DSH_BRIDGE_PROTOCOL)};
const AGENT_METHODS = ["followup", "steer", "cancel"];
const INBOX_METHODS = ["remove"];

function write(value) { process.stdout.write(JSON.stringify(value) + "\n"); }

// A native error object can hold anything; only what JSON can carry crosses, so a report never throws into the runtime.
function jsonSafe(value) {
  try { return JSON.stringify(value) === undefined ? undefined : value; } catch { return undefined; }
}

function structured(error, depth = 0) {
  if (error === null || typeof error !== "object") { return { message: String(error) }; }
  const fields = {};
  for (const key of Object.keys(error)) {
    const value = key === "cause" ? undefined : jsonSafe(error[key]);
    if (value !== undefined) { fields[key] = value; }
  }
  const cause = depth < 4 && error.cause !== undefined ? { cause: structured(error.cause, depth + 1) } : {};
  return { ...fields, name: error.name, message: String(error.message), ...cause };
}

function methods(target, names) {
  return Object.fromEntries(names.map((key) => [key, typeof target?.[key] === "function"]));
}

function refusal(code, message, capability) {
  const error = new Error(message);
  error.code = code;
  if (capability !== undefined) { error.capability = capability; }
  return error;
}

function requireMethod(target, key, capability) {
  if (typeof target?.[key] !== "function") {
    throw refusal("native_method_unavailable", "This DSH does not provide " + key + "(), which " + capability + " requires", capability);
  }
}

function userMessage(text, inputId) {
  const id = inputId ?? randomUUID();
  return Object.freeze({ id, role: "user", content: Object.freeze([Object.freeze({ type: "text", text })]), source: Object.freeze({ kind: "user" }) });
}

export function apply(ctx, config) {
  const loader = ctx.get("loader");
  if (typeof loader?.await !== "function") {
    write({ type: "startup-error", error: { message: "This DSH does not provide loader.await(), which starting the bridge requires" }, capability: "startup", code: "native_method_unavailable" });
    return;
  }
  // Activation must not wait for the barrier it observes.
  void (async () => {
    try { await loader.await(); boot(ctx, config); }
    catch (error) { write({ type: "startup-error", error: structured(error) }); }
  })();
}

function boot(ctx) {
  const agents = ctx.get("agents");
  const persistence = ctx.get("sessionPersistence");
  const handles = new Map();
  const owned = (sessionId) => {
    const handle = handles.get(sessionId);
    if (handle === undefined) { throw refusal("unknown_session", "This process does not own session " + sessionId); }
    return handle;
  };
  // A withdrawal commits a native cancelled splice before remove() returns;
  // this routing field tells it apart from one an abort caused.
  let cause;
  ctx.on("session/event", (session, event) => { write({ type: "native", channel: "session/event", sessionId: session.header.id, ...(cause === undefined ? {} : { cause }), event }); });
  ctx.on("agent/assistant-stream", ({ agent, frame }) => { write({ type: "native", channel: "agent/assistant-stream", sessionId: agent.session.id, frame }); });
  ctx.on("agent/status", ({ agent, status }) => { write({ type: "native", channel: "agent/status", sessionId: agent.session.id, status }); });
  ctx.on("agent/error", ({ agent, turn, step, error }) => { write({ type: "native", channel: "agent/error", sessionId: agent.session.id, turn, step, error: structured(error) }); });
  for (const channel of ["subagent/start", "subagent/end"]) { ctx.on(channel, (info) => { write({ type: "native", channel, info }); }); }

  const opened = (handle) => {
    const { agent } = handle;
    handles.set(agent.session.id, handle);
    const modelCurrent = typeof agent.model?.current === "function";
    return { sessionId: agent.session.id, header: agent.session.header, status: agent.status,
      methods: methods(agent, AGENT_METHODS), inboxMethods: methods(agent.inbox, INBOX_METHODS),
      pending: { nextTurn: agent.inbox?.nextTurn?.length, nextStep: agent.inbox?.nextStep?.length },
      modelCurrent, ...(modelCurrent ? { model: agent.model.current() } : {}) };
  };

  // Native validation before any turn; a route the runtime cannot run is refused at open.
  const validated = async (route, explicit) => {
    const llm = ctx.get("llm");
    if (explicit.reasoningEffort !== undefined) { requireMethod(llm, "resolveCallConfig", "confirming a reasoning effort"); }
    if ((explicit.provider !== undefined || explicit.reasoningEffort !== undefined) && typeof llm?.resolveCallConfig === "function") { await llm.resolveCallConfig(route); }
    return route;
  };
  const defaultRoute = () => {
    const defaults = ctx.get("agentDefaultModel");
    return typeof defaults?.currentSelection === "function" ? defaults.currentSelection() : {};
  };

  const commands = {
    async open(request) {
      requireMethod(agents, "create", "opening a session");
      const explicit = request.agentOptions ?? {};
      const route = await validated(explicit.provider === undefined ? { ...defaultRoute(), ...explicit } : explicit, explicit);
      return opened(await agents.create({ sessionId: request.sessionId, meta: { cwd: request.cwd }, agentOptions: route }));
    },
    // The saved header and route, read without taking the session over.
    async peek(request) {
      requireMethod(persistence, "open", "reading a saved session before resume");
      const stored = await persistence.open(request.sessionId, "read");
      try {
        const log = await stored.read();
        const last = log.events.findLast((event) => event.type === "request/header");
        const config = last?.data?.header?.config;
        const defaulted = last?.data?.header?.adapterDefaults?.reasoningEffort === true;
        return { header: stored.header, ...(config === undefined ? {} : { route: { provider: config.provider, model: config.model,
          ...(config.reasoningEffort === undefined || defaulted ? {} : { reasoningEffort: config.reasoningEffort }) } }) };
      } finally { await stored.close(); }
    },
    async resume(request) {
      requireMethod(agents, "resume", "resuming a session");
      const explicit = request.agentOptions ?? {};
      const saved = request.route ?? defaultRoute();
      const route = await validated(explicit.provider === undefined ? { ...saved, ...explicit } : explicit, explicit);
      const handle = await agents.resume({ resumeSessionId: request.sessionId, agentOptions: route });
      // Releases with a recorded selection keep the saved route over these options unless told otherwise.
      if ((explicit.provider !== undefined || explicit.reasoningEffort !== undefined) && typeof handle.agent.model?.select === "function") { handle.agent.model.select(route); }
      return opened(handle);
    },
    prompt(request) {
      const { agent } = owned(request.sessionId);
      requireMethod(agent, "followup", "prompt");
      if (agent.status !== "idle") { throw refusal("busy", "busy"); }
      const message = userMessage(request.text, request.inputId);
      agent.followup(message);
      return { messageId: message.id };
    },
    queue(request) {
      const { agent } = owned(request.sessionId);
      requireMethod(agent, "followup", "queue");
      const message = userMessage(request.text, request.inputId);
      agent.followup(message);
      return { messageId: message.id };
    },
    steer(request) {
      const { agent } = owned(request.sessionId);
      requireMethod(agent, "steer", "steer");
      if (agent.status === "idle") { throw refusal("no_active_turn", "no active turn"); }
      const message = userMessage(request.text, request.inputId);
      agent.steer(message);
      return { messageId: message.id };
    },
    withdraw(request) {
      const { agent } = owned(request.sessionId);
      requireMethod(agent.inbox, "remove", "withdraw");
      // Only input held for a later turn: a steer may already be in the next request.
      if (!agent.inbox.nextTurn.some((message) => message.id === request.messageId)) { return { removed: false }; }
      cause = "withdraw";
      try { return { removed: agent.inbox.remove(request.messageId) }; } finally { cause = undefined; }
    },
    cancel(request) {
      const { agent } = owned(request.sessionId);
      requireMethod(agent, "cancel", "abort");
      if (agent.status === "idle") { throw refusal("no_active_turn", "no active turn"); }
      agent.cancel({ kind: "user" }, { keepInbox: false });
      return {};
    },
    async dispose() {
      const results = await Promise.allSettled([...handles.values()].map(async (handle) => { await handle.dispose(); }));
      handles.clear();
      if (typeof persistence?.flush === "function") { await persistence.flush(); }
      const failed = results.find((result) => result.status === "rejected");
      if (failed !== undefined) { throw failed.reason; }
      return {};
    },
  };

  write({ type: "ready", protocol: PROTOCOL,
    services: { agents: methods(agents, ["create", "resume"]), sessionPersistence: methods(persistence, ["list", "open", "flush"]) } });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => { void receive(line); });
  async function receive(line) {
    let request = null;
    try { request = JSON.parse(line); }
    catch (error) { write({ type: "protocol-error", error: structured(error), line }); return; }
    if (request === null || typeof request !== "object" || typeof request.id !== "string" || typeof commands[request.method] !== "function") {
      write({ type: "protocol-error", error: { message: "Expected a command with an id and a known method" }, line });
      return;
    }
    try { write({ type: "response", id: request.id, result: await commands[request.method](request) }); }
    catch (error) { write({ type: "response", id: request.id, error: structured(error), code: error?.code, capability: error?.capability }); }
  }
  ctx.effect(() => () => { input.close(); });
}
`;
