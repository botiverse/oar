// oxlint-disable -- A stand-in executable, deliberately untyped like the services it fakes.
// A stand-in `dsh`: it loads the real bridge text OAR wrote, from the --patch row
// OAR wrote, over fake injected services. FAKE_DSH_MODE selects the fault.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_DSH_MODE ?? "ok";
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: dsh [--profile] <name> [options] [app-args...]\ndsh: boot a DeepSeek Harness profile\n");
  process.exit(0);
}
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_DSH_VERSION ?? "0.2.1-rc.5"}\n`);
  process.exit(0);
}
const patch = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--patch") + 1], "utf8"));
if (process.argv[process.argv.indexOf("--profile") + 1] !== "acp" || patch[0].id !== "acp" || patch[0].disabled !== true) { process.exit(9); }
const bridgeRow = patch[1].insert.find(row => row.id === "oar-dsh-bridge");
if (process.env.FAKE_DSH_PATCH_RECEIPT) { writeFileSync(process.env.FAKE_DSH_PATCH_RECEIPT, JSON.stringify(patch)); }
// The host-declared provider OAR writes (SessionOptions.dshProvider): its
// applied llm-pi-ai config is what the real loader exposes, and the model plane
// knows exactly those models.
const providerPatch = patch.find(row => row.id === "llm-pi-ai");
const providers = providerPatch === undefined || process.env.FAKE_DSH_PROVIDER_IGNORE_PATCH === "1"
  ? {}
  : providerPatch.config?.providers ?? {};
if (process.env.FAKE_DSH_HOLD_BEFORE_PROFILE) {
  writeFileSync(process.env.FAKE_DSH_HOLD_BEFORE_PROFILE, "waiting");
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once("end", resolve));
  process.exit(0);
}
const bridge = await import(bridgeRow.name);

if (mode === "exit-before-ready") { process.stderr.write("native startup failed\n"); process.exit(3); }
if (mode === "stdout-noise") { process.stdout.write("not json at all\n"); }

const listeners = new Map();
const on = (channel, listener) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; };
const emit = (channel, ...args) => { for (const listener of listeners.get(channel) ?? []) { listener(...args); } };
const missing = new Set((process.env.FAKE_DSH_MISSING ?? "").split(",").filter((name) => name.length > 0));
const sessions = new Map();
const materializedFiles = new Map();
const bufferedFiles = new Map();
const turnCounts = new Map();
const disposedSessions = new Set();
const fakeSessionFile = (id, turn = 1) => process.env.FAKE_DSH_SESSION_FILE?.replace("{id}", id).replace("{turn}", String(turn));

function materializeBuffered(id) {
  const path = bufferedFiles.get(id);
  if (path === undefined) { return; }
  bufferedFiles.delete(id);
  if (process.env.FAKE_DSH_SESSION_FILE_WRITE !== "0") { writeFileSync(path, "{\"type\":\"session\"}\n"); }
  materializedFiles.set(id, path);
}

function makeAgent(id) {
  const nextTurn = [];
  const header = { id, cwd: process.env.FAKE_DSH_CWD ?? process.cwd() };
  const session = { id, header, seq: 0 };
  const agent = {
    session,
    status: "idle",
    inbox: {
      get nextTurn() { return nextTurn; },
      nextStep: [],
      ...(missing.has("remove") ? {} : { remove(messageId) {
        const index = nextTurn.findIndex((message) => message.id === messageId);
        if (index < 0) { return false; }
        nextTurn.splice(index, 1);
        emit("session/event", session, { type: "agent/inbox/spliced", seq: 0, time: 0, data: { target: "next-turn", start: index, removedCount: 1, inserted: [], outcome: "canceled" } });
        return true;
      } }),
    },
  };
  if (!missing.has("followup")) { agent.followup = (message) => {
    if (agent.status === "idle" && mode !== "hold") {
      agent.status = "running";
      emit("session/event", session, { type: "turn/start", seq: 0, time: 0, data: { turn: 1 } });
      setTimeout(() => {
        const turn = (turnCounts.get(id) ?? 0) + 1;
        turnCounts.set(id, turn);
        session.seq = turn;
        const path = fakeSessionFile(id, turn);
        if (path !== undefined) {
          if (process.env.FAKE_DSH_BUFFER_UNTIL_FLUSH === "1") { bufferedFiles.set(id, path); }
          else {
            if (process.env.FAKE_DSH_SESSION_FILE_WRITE !== "0") { writeFileSync(path, "{\"type\":\"session\"}\n"); }
            materializedFiles.set(id, path);
          }
        }
        emit("agent/error", { agent, turn, step: 0, error: Object.assign(new Error("first"), { code: "X", cause: new Error("second") }) });
        emit("session/event", session, { type: "turn/end", seq: turn, time: 0, data: { turn, reason: { kind: "completed" } } });
        agent.status = "idle";
      }, 5);
      return;
    }
    agent.status = "running";
    nextTurn.push(message);
    emit("session/event", session, { type: "agent/inbox/spliced", seq: 0, time: 0, data: { target: "next-turn", start: nextTurn.length - 1, inserted: [message] } });
  }; }
  if (!missing.has("steer")) { agent.steer = () => {}; }
  if (!missing.has("cancel")) { agent.cancel = () => { nextTurn.length = 0; agent.status = "idle"; }; }
  if (process.env.FAKE_DSH_MODEL !== undefined) { agent.model = { current: () => JSON.parse(process.env.FAKE_DSH_MODEL) }; }
  return agent;
}

function handleFor(id) {
  const agent = makeAgent(id);
  sessions.set(id, agent);
  return { agent, dispose: async () => { disposedSessions.add(id); if (mode === "dispose-fails") { throw new Error("native dispose failed"); } } };
}

const agents = {
  ...(missing.has("create") ? {} : { create: async ({ sessionId, setup }) => { const handle = handleFor(mode === "wrong-id" ? "another-id" : sessionId); await setup?.({}, handle.agent); return handle; } }),
  ...(missing.has("resume") ? {} : { resume: async ({ resumeSessionId, setup }) => { const handle = handleFor(resumeSessionId); await setup?.({}, handle.agent); return handle; } }),
};
const persistence = {
  ...(missing.has("open") ? {} : { open: async (id) => {
    if (id.startsWith("00000000")) { throw Object.assign(new Error(`session "${id}" not found`), { name: "SessionPersistenceNotFoundError", sessionId: id }); }
    return { header: { id, ...(mode === "no-saved-cwd" ? {} : { cwd: process.env.FAKE_DSH_CWD ?? process.cwd() }) }, read: async () => ({ events: [] }), close: async () => {} };
  } }),
  ...(missing.has("stat") ? {} : { stat: async (id) => {
    if (process.env.FAKE_DSH_STAT_THROW_AFTER_DISPOSE === "1" && disposedSessions.has(id)) {
      throw new Error("stat unavailable after dispose");
    }
    const path = materializedFiles.get(id) ?? (process.env.FAKE_DSH_SESSION_FILE_AT_OPEN === "1" ? fakeSessionFile(id) : undefined);
    return { header: { id, cwd: process.env.FAKE_DSH_CWD ?? process.cwd() }, revision: "1", ...(path === undefined ? {} : { location: { kind: "jsonl", path } }) };
  } }),
  flush: async () => { for (const id of [...bufferedFiles.keys()]) { materializeBuffered(id); } },
};
const sessionStore = {
  get: (id) => sessions.get(id)?.session,
  flush: async (session) => { materializeBuffered(session.id); },
};
const declaredModels = (provider) => (providers[provider]?.models ?? []).map((model) => ({ provider, id: model.id, name: model.name ?? model.id }));
const llm = {
  listProviders: () => [{ id: "local", name: "Local" }, ...Object.keys(providers).map((id) => ({ id, name: id })), ...(mode === "listing-fails" ? [{ id: "broken", name: "Broken" }] : [])],
  listModels: async (provider) => {
    if (providers[provider] !== undefined) { return declaredModels(provider); }
    if (provider === "broken" || mode === "listing-fails") { throw new Error("no credential"); }
    if (mode === "empty-models") { return []; }
    return [{ provider, id: "plain", name: "Plain" }, { provider, id: "thinks", name: "Thinks" }];
  },
  resolveModelInfo: async (provider, id) => {
    if (providers[provider] !== undefined) {
      const known = declaredModels(provider).find((model) => model.id === id);
      if (known === undefined) { throw Object.assign(new Error(`no configured model "${id}"`), { code: "UNKNOWN_MODEL" }); }
      return known;
    }
    return { provider, id, ...(id === "thinks" ? { reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } } : {}), ...(process.env.FAKE_DSH_IMAGES === "1" ? { inputModalities: ["text", "image"] } : {}) };
  },
  ...(missing.has("resolveCallConfig") ? {} : { resolveCallConfig: async (route) => {
    if (route.reasoningEffort === "bad") { throw Object.assign(new Error('does not support reasoning effort "bad"'), { code: "UNSUPPORTED_REASONING_EFFORT" }); }
    if (providers[route.provider] !== undefined && !providers[route.provider].models.some((model) => model.id === route.model)) {
      throw Object.assign(new Error(`no configured model "${route.model}"`), { code: "UNKNOWN_MODEL" });
    }
    if (route.model === "bad") { throw Object.assign(new Error('no configured model "bad"'), { code: "UNKNOWN_MODEL" }); }
    return route;
  } }),
};
const skills = { ...(missing.has("snapshot") ? {} : { snapshot: async ({ cwd }) => {
  if (mode === "skills-error") { throw new Error("PRIVATE_SKILL_ERROR"); }
  if (mode === "skills-hang") { await new Promise(() => {}); }
  if (process.env.FAKE_DSH_SKILLS !== undefined) { return JSON.parse(process.env.FAKE_DSH_SKILLS); }
  return { skills: [{ name: "fixture", path: cwd, source: "project-dsh", description: process.env.OAR_SKILL_DESCRIPTION,
    invocation: { modelInvocable: false, userInvocable: true }, content: "PRIVATE_SKILL_BODY", provider: "filesystem" }], complete: true };
} }) };
const attachments = process.env.FAKE_DSH_IMAGES === "1" ? {
  imageLimits: { mediaTypes: ["image/png"] },
  saveImages: async (imgs) => { await new Promise((resolve) => { setTimeout(resolve, 30); }); return imgs.map((_, index) => ({ id: `att-${index}` })); },
} : undefined;
const services = { agents, sessions: sessionStore, sessionPersistence: persistence, llm, skills, ...(attachments === undefined ? {} : { attachments }), ...(mode === "no-default" ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: "local", model: "thinks" }) } }) };
const sessionLogPatch = patch.find((row) => row.id === "session-log-deepseek");
const sessionLogEntry = missing.has("session-log-deepseek") ? [] : [{
  options: {
    id: "session-log-deepseek",
    name: process.env.FAKE_DSH_SESSION_LOG_NAME ?? "@deepseek-ai/dsh-session-log-deepseek",
    ...(process.env.FAKE_DSH_SESSION_LOG_DISABLED === "1" ? { disabled: true } : {}),
    ...(sessionLogPatch !== undefined && process.env.FAKE_DSH_SESSION_LOG_IGNORE_PATCH !== "1" && (sessionLogPatch.name === undefined || sessionLogPatch.name === (process.env.FAKE_DSH_SESSION_LOG_NAME ?? "@deepseek-ai/dsh-session-log-deepseek"))
      ? { config: sessionLogPatch.config }
      : {}),
  },
  fiber: { state: Number(process.env.FAKE_DSH_SESSION_LOG_STATE ?? "2"), await: async () => {} },
}];
const providerEntry = process.env.FAKE_DSH_PROVIDER_MISSING === "1" ? [] : [{
  options: {
    id: "llm-pi-ai",
    name: process.env.FAKE_DSH_PROVIDER_NAME ?? "@deepseek-ai/dsh-llm-pi-ai",
    ...(process.env.FAKE_DSH_PROVIDER_DISABLED === "1" ? { disabled: true } : {}),
    config: { providers },
  },
  fiber: { state: Number(process.env.FAKE_DSH_PROVIDER_STATE ?? "2"), await: async () => {} },
}];
const loader = {
  await: async () => { if (mode === "barrier-fails") { throw new Error("barrier failed"); } },
  ...(mode === "no-mcp-method" ? {} : { import: async () => ({}), unwrapExports: value => value }),
  ...(mode === "no-loader-entries" ? {} : {
    entries: () => [
      ...patch[1].insert.map(options => ({ options, fiber: { state: mode === "mcp-inactive" ? 0 : 2, await: async () => {} } })),
      ...sessionLogEntry,
      ...providerEntry,
    ],
  }),
};
const ctx = {
  plugin: (_plugin, config) => {
    if (process.env.FAKE_DSH_MCP_RECEIPT) {
      const launch = [JSON.stringify(patch), ...process.argv, ...Object.values(process.env)];
      const values = Object.values(config.env ?? config.headers ?? {});
      const isolated = values.length === 1 && launch.every(field => !field.includes(values[0]));
      appendFileSync(process.env.FAKE_DSH_MCP_RECEIPT, config.transport + ":" + isolated + "\n");
    }
    return { ctx: { fiber: { state: mode === "mcp-inactive" ? 0 : 2, await: async () => {} } } };
  },
  get: (name) => name === "loader" ? (mode === "no-loader" ? undefined : loader) : services[name],
  on,
  effect: () => {},
};
bridge.apply(ctx, bridgeRow.config ?? {});
if (mode === "hang") { setInterval(() => {}, 1000); }
process.stdin.on("end", () => { process.exit(0); });
