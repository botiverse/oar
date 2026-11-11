import { killGraceMs } from "../../../shared/executable/index.js";

/*
 * The script a cursor child runs: `process.execPath -e SCRIPT SPEC`. It is
 * self-contained (Node built-ins only, nothing from OAR), because hosts bundle
 * OAR and a separate file next to OAR's code may not exist; it is kept small
 * for the Windows command line limit. SPEC is `[sdkModule, graceMs,
 * electronRunAsNode]`.
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
 * When the IPC channel disconnects (the host ended or died, SIGKILL
 * included) the child ends its own tree: SIGTERM to its process group, then
 * SIGKILL to it after the grace period (POSIX); `taskkill /T /F` on itself
 * (Windows). A SIGTERM from the host ends it at once with code 0; the host
 * then ends what is left of its group.
 */
const SCRIPT = String.raw`
const [sdkModule, graceMs, electron] = JSON.parse(process.argv[1]);
const path = require("node:path");
const windows = process.platform === "win32";
let stopping = false;
const group = (signal) => { try { process.kill(-process.pid, signal); } catch {} };
process.on("SIGTERM", () => { if (!stopping) { process.exit(0); } });
process.on("disconnect", () => {
  if (stopping) { return; }
  stopping = true;
  if (windows) {
    try { require("node:child_process").execFileSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 }); } catch {}
    process.exit(1);
  }
  group("SIGTERM");
  setTimeout(() => { group("SIGKILL"); process.exit(1); }, graceMs);
});
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
const agents = new Map();
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
  close: (id, agent) => { agents.get(agent)?.close(); agents.delete(agent); },
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

/** The launch of one cursor child: the script, its spec, and its environment with `ELECTRON_RUN_AS_NODE=1`. */
export function cursorChildLaunch(sdkModule: string, env: Readonly<NodeJS.ProcessEnv>): { readonly script: string; readonly argument: string; readonly env: NodeJS.ProcessEnv } {
  const spec = [sdkModule, Math.floor(killGraceMs() / 2), env.ELECTRON_RUN_AS_NODE ?? null];
  return { script: SCRIPT, argument: JSON.stringify(spec), env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}
