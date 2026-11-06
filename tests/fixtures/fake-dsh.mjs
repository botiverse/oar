// oxlint-disable -- A stand-in executable, deliberately untyped like the services it fakes.
// A stand-in `dsh`: it loads the real bridge text OAR wrote, from the --patch row
// OAR wrote, over fake injected services. FAKE_DSH_MODE selects the fault.
import { readFileSync } from "node:fs";

const mode = process.env.FAKE_DSH_MODE ?? "ok";
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_DSH_VERSION ?? "0.2.1-rc.5"}\n`);
  process.exit(0);
}
const patch = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--patch") + 1], "utf8"));
if (process.argv[process.argv.indexOf("--profile") + 1] !== "acp" || patch[0].id !== "acp" || patch[0].disabled !== true) { process.exit(9); }
const bridgeRow = patch[1].insert.find(row => row.id === "oar-dsh-bridge");
const bridge = await import(bridgeRow.name);

if (mode === "exit-before-ready") { process.stderr.write("native startup failed\n"); process.exit(3); }
if (mode === "stdout-noise") { process.stdout.write("not json at all\n"); }

const listeners = new Map();
const on = (channel, listener) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; };
const emit = (channel, ...args) => { for (const listener of listeners.get(channel) ?? []) { listener(...args); } };
const missing = new Set((process.env.FAKE_DSH_MISSING ?? "").split(",").filter((name) => name.length > 0));
const sessions = new Map();

function makeAgent(id) {
  const nextTurn = [];
  const header = { id, cwd: process.env.FAKE_DSH_CWD ?? process.cwd() };
  const session = { id, header };
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
        emit("agent/error", { agent, turn: 1, step: 0, error: Object.assign(new Error("first"), { code: "X", cause: new Error("second") }) });
        emit("session/event", session, { type: "turn/end", seq: 1, time: 0, data: { turn: 1, reason: { kind: "completed" } } });
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
  return { agent, dispose: async () => { if (mode === "dispose-fails") { throw new Error("native dispose failed"); } } };
}

const agents = {
  ...(missing.has("create") ? {} : { create: async ({ sessionId }) => { const handle = handleFor(mode === "wrong-id" ? "another-id" : sessionId); return handle; } }),
  ...(missing.has("resume") ? {} : { resume: async ({ resumeSessionId }) => handleFor(resumeSessionId) }),
};
const persistence = {
  ...(missing.has("open") ? {} : { open: async (id) => {
    if (id.startsWith("00000000")) { throw Object.assign(new Error(`session "${id}" not found`), { name: "SessionPersistenceNotFoundError", sessionId: id }); }
    return { header: { id, cwd: process.env.FAKE_DSH_CWD ?? process.cwd() }, read: async () => ({ events: [] }), close: async () => {} };
  } }),
  flush: async () => {},
};
const llm = {
  listProviders: () => [{ id: "local", name: "Local" }, ...(mode === "listing-fails" ? [{ id: "broken", name: "Broken" }] : [])],
  listModels: async (provider) => {
    if (provider === "broken" || mode === "listing-fails") { throw new Error("no credential"); }
    return [{ provider, id: "plain", name: "Plain" }, { provider, id: "thinks", name: "Thinks" }];
  },
  resolveModelInfo: async (provider, id) => ({ provider, id, ...(id === "thinks" ? { reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "low" } } : {}) }),
  ...(missing.has("resolveCallConfig") ? {} : { resolveCallConfig: async (route) => {
    if (route.reasoningEffort === "bad") { throw Object.assign(new Error('does not support reasoning effort "bad"'), { code: "UNSUPPORTED_REASONING_EFFORT" }); }
    if (route.model === "bad") { throw Object.assign(new Error('no configured model "bad"'), { code: "UNKNOWN_MODEL" }); }
    return route;
  } }),
};
const services = { agents, sessionPersistence: persistence, llm, ...(mode === "no-default" ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: "local", model: "thinks" }) } }) };
const loader = {
  await: async () => { if (mode === "barrier-fails") { throw new Error("barrier failed"); } },
  ...(mode === "mcp-inactive" ? { entries: () => patch[1].insert.map(options => ({ options, fiber: { state: 0, await: async () => {} } })) } : {}),
};
const ctx = {
  get: (name) => name === "loader" ? (mode === "no-loader" ? undefined : loader) : services[name],
  on,
  effect: () => {},
};
bridge.apply(ctx, bridgeRow.config ?? {});
if (mode === "hang") { setInterval(() => {}, 1000); }
process.stdin.on("end", () => { process.exit(0); });
