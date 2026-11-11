import path from "node:path";
import { environmentValue, sessionEnvironment } from "../../../shared/environment.js";
import { killGraceMs } from "../../../shared/executable/index.js";

/*
 * The script a cursor child runs: `process.execPath -e SCRIPT SPEC`. It is
 * self-contained (Node built-ins only, nothing from OAR), because hosts bundle
 * OAR and a separate file next to OAR's code may not exist; it is kept small
 * for the Windows command line limit. SPEC is `[sdkModule, graceMs,
 * electronRunAsNode, taskkill]`.
 *
 * Before the SDK loads, the child puts back the environment's own
 * `ELECTRON_RUN_AS_NODE` (the host set it to 1 only so an Electron
 * `process.execPath` runs the script as Node), and sets the SDK's native
 * companion paths the way `cursorNativeEnvironment()` resolves them, from
 * `sdkModule`, unless the environment already has them.
 *
 * Protocol (Node IPC, plain data only). Host to child: `{ id, m, a }`, a
 * call of method `m` with arguments `a`. Child to host: `{ t: "ready" }`
 * once the SDK loaded (or `e`, its error), with what the SDK has in `v`;
 * `{ t: "reply", id, v | e }` answering a call; `{ t: "event", id, v }`
 * during a call: a send's `onDelta` updates, a stream's messages, a
 * login's URL and save request. Values the SDK returns are copied through
 * JSON; errors cross as their name, message and scalar fields.
 *
 * The login never sends its credentials: the SDK's `store.save` asks the
 * host (`save`), the host answers with `commit` (save to the SDK's own
 * `FileCredentialStore` in this process), then `saved`, or `refused` with
 * the reason, and the login's own reply carries no value.
 *
 * Closing an agent awaits its `Symbol.asyncDispose` when it has one (SDK
 * 1.3.1: `close()` only starts its async close work). Shutting down (the
 * host's `shutdown` call, a SIGTERM, or the IPC channel disconnecting
 * because the host ended or died, SIGKILL included) closes every open agent
 * and waits for the closes for up to `graceMs`, then exits. On exit, also
 * an exit after an uncaught exception, the child ends every descendant it
 * has: found by parent pid (POSIX: `/proc/<pid>/stat` on Linux, `ps -A -o
 * pid=,ppid=` elsewhere), so tools that lead process groups of their own
 * are reached too, plus the ones seen when the shutdown began; Windows:
 * `taskkill /T /F` on itself, which walks by parent. After a disconnect,
 * with no host left to do it, it also SIGKILLs its own process group.
 */
const SCRIPT = String.raw`
const [sdkModule, graceMs, electron, taskkill] = JSON.parse(process.argv[1]);
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const windows = process.platform === "win32";
let stopping = false;
let orphaned = false;
let seen = new Map();
const table = () => {
  if (process.platform === "linux") {
    const rows = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) { continue; }
      try {
        const stat = fs.readFileSync("/proc/" + name + "/stat", "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push([Number(name), Number(fields[1]), fields[19]]);
      } catch {}
    }
    return rows;
  }
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 10000 }).split("\n")
    .map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length > 2).map((cells) => [Number(cells[0]), Number(cells[1]), cells.slice(2).join(" ")]);
};
const descendants = (rows) => {
  const below = new Map();
  for (const row of rows) { below.set(row[1], [...(below.get(row[1]) ?? []), row]); }
  const found = new Map();
  const pending = [process.pid];
  while (pending.length > 0) {
    for (const row of below.get(pending.pop()) ?? []) {
      if (!found.has(row[0])) { found.set(row[0], row[2]); pending.push(row[0]); }
    }
  }
  return found;
};
const remember = () => { if (!windows) { try { seen = descendants(table()); } catch {} } };
process.on("exit", () => {
  try {
    if (windows) { execFileSync(taskkill, ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 }); return; }
    const rows = table();
    const now = new Map(rows.map((row) => [row[0], row[2]]));
    const targets = new Map([...[...seen].filter(([pid, start]) => now.get(pid) === start), ...descendants(rows)]);
    for (const pid of targets.keys()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  } catch {}
  if (orphaned) { try { process.kill(-process.pid, "SIGKILL"); } catch {} }
});
const agents = new Map();
const closing = new Set();
const closeAgent = (agent) => {
  const done = (async () => { if (typeof agent[Symbol.asyncDispose] === "function") { await agent[Symbol.asyncDispose](); } else { agent.close(); } })();
  closing.add(done);
  return done;
};
const shutdown = async (code) => {
  if (stopping) { return; }
  stopping = true;
  remember();
  for (const agent of agents.values()) { void closeAgent(agent); }
  agents.clear();
  await Promise.race([Promise.allSettled([...closing]), new Promise((resolve) => { setTimeout(resolve, graceMs); })]);
  process.exit(code);
};
process.on("SIGTERM", () => { void shutdown(0); });
process.on("disconnect", () => { orphaned = true; void shutdown(1); });
if (electron === null) { delete process.env.ELECTRON_RUN_AS_NODE; } else { process.env.ELECTRON_RUN_AS_NODE = electron; }
try {
  const root = path.dirname(require("node:module").createRequire(sdkModule).resolve("@cursor/sdk-" + process.platform + "-" + process.arch + "/package.json"));
  process.env.CURSOR_TREE_SITTER_VENDOR_DIR ??= path.join(root, "vendor");
  process.env.CURSOR_RIPGREP_PATH ??= path.join(root, "bin", windows ? "rg.exe" : "rg");
} catch {}
const post = (message) => { if (process.connected) { process.send(message); } };
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const fault = (error) => {
  if (!(error instanceof Error)) { return { name: "Error", message: String(error) }; }
  const out = {};
  for (const key of [...Object.keys(error), "code", "status", "operation", "isRetryable"]) {
    if (["string", "number", "boolean"].includes(typeof error[key])) { out[key] = error[key]; }
  }
  return { ...out, name: error.name, message: error.message };
};
let sdk;
let pending;
let abort;
const runs = new Map();
const streams = new Map();
const opened = async (id, opening) => {
  const agent = await opening;
  agents.set(id, agent);
  return { agentId: agent.agentId, model: agent.model, summarize: typeof agent.summarize === "function" };
};
const started = async (id, starting) => {
  const run = await starting;
  runs.set(id, run);
  return { runId: run.id, steer: typeof run.steer === "function" };
};
const calls = {
  models: () => sdk.Cursor.models.list(),
  listRuns: (id, agentId, options) => sdk.Agent.listRuns(agentId, options),
  create: (id, options) => opened(id, sdk.Agent.create(options)),
  resume: (id, agentId, options) => opened(id, sdk.Agent.resume(agentId, options)),
  send: (id, agent, message, local) => started(id, agents.get(agent).send(message, { onDelta: ({ update }) => post({ t: "event", id, v: plain(update) }), ...(local ? { local } : {}) })),
  summarize: (id, agent) => started(id, agents.get(agent).summarize()),
  close: async (id, key) => { const agent = agents.get(key); agents.delete(key); if (agent !== undefined) { await closeAgent(agent); } },
  shutdown: () => { void shutdown(0); },
  wait: (id, run) => runs.get(run).wait(),
  cancel: (id, run) => runs.get(run).cancel(),
  steer: (id, run, text) => runs.get(run).steer(text),
  stream: async (id, run) => {
    const iterator = runs.get(run).stream()[Symbol.asyncIterator]();
    streams.set(id, iterator);
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) { return; }
        post({ t: "event", id, v: plain(next.value) });
      }
    } finally { streams.delete(id); }
  },
  unstream: (id, stream) => { void streams.get(stream)?.return?.(); },
  status: () => sdk.Cursor.auth.status(),
  logout: async () => { await sdk.Cursor.auth.logout(); },
  login: async (id) => {
    abort = new AbortController();
    const store = {
      load: async () => undefined,
      clear: async () => { throw new Error("oar's cursor login never clears the stored login"); },
      save: (credentials) => new Promise((resolve, reject) => { pending = { credentials, resolve, reject }; post({ t: "event", id, v: { save: true } }); }),
    };
    await sdk.Cursor.auth.login({ openBrowser: false, signal: abort.signal, onLoginUrl: (url) => post({ t: "event", id, v: { url } }), store });
  },
  abortLogin: () => { abort?.abort(); },
  commit: async () => { const { credentials } = pending; pending.credentials = undefined; await new sdk.FileCredentialStore().save(credentials); },
  saved: () => { pending.resolve(); },
  refused: (id, message) => { pending.reject(new Error(message)); },
};
process.on("message", async ({ id, m, a }) => {
  try { post({ t: "reply", id, v: plain(await calls[m](id, ...a)) }); }
  catch (error) { post({ t: "reply", id, e: fault(error) }); }
});
import(sdkModule).then((module) => {
  sdk = module;
  const auth = module.Cursor?.auth;
  post({ t: "ready", v: { auth: auth !== undefined, logout: typeof auth?.logout === "function", store: typeof module.FileCredentialStore === "function" } });
}, (error) => { post({ t: "ready", e: fault(error) }); });
`;

/**
 * Windows: taskkill by absolute path from the host's own `SystemRoot`, since
 * the child's environment may have no PATH (`envBase: "clean"`).
 */
function taskkillPath(): string | null {
  if (process.platform !== "win32") { return null; }
  return path.win32.join(environmentValue(process.env, "SystemRoot") ?? String.raw`C:\Windows`, "System32", "taskkill.exe");
}

/** The launch of one cursor child: the script, its spec, and its environment with `ELECTRON_RUN_AS_NODE=1`. */
export function cursorChildLaunch(sdkModule: string, env: Readonly<NodeJS.ProcessEnv>): { readonly script: string; readonly argument: string; readonly env: NodeJS.ProcessEnv } {
  const spec = [sdkModule, Math.floor(killGraceMs() / 2), environmentValue(env, "ELECTRON_RUN_AS_NODE") ?? null, taskkillPath()];
  return { script: SCRIPT, argument: JSON.stringify(spec), env: sessionEnvironment({ ELECTRON_RUN_AS_NODE: "1" }, env) };
}
