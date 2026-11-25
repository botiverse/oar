import { createRequire } from "node:module";
import path from "node:path";
import { installIpcChildGuards } from "../../../shared/executable/child-guards.js";
import { asRecord, parseJson } from "../../../shared/json.js";

export interface ParsedCursorChildSpec {
  readonly sdkModule: string;
  readonly graceMs: number;
  readonly electron: string | null | false;
  readonly taskkill: string | null;
  readonly marker: string;
}

interface PendingLoginSave {
  credentials: unknown;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface ChildRuntimeState {
  sdk: unknown;
  pending: PendingLoginSave | undefined;
  abort: AbortController | undefined;
  readonly agents: Map<unknown, unknown>;
  readonly closing: Set<Promise<unknown>>;
  readonly runs: Map<unknown, unknown>;
  readonly streams: Map<unknown, { return?: () => unknown }>;
}

function isValidElectronSpec(value: unknown): value is string | null | false {
  return value === null || value === false || typeof value === "string";
}

/** Parse and validate the opaque JSON spec passed to `runCursorChild`. */
export function parseCursorChildSpec(spec: string): ParsedCursorChildSpec {
  if (typeof spec !== "string" || spec.trim() === "") { throw new RangeError("runCursorChild expected a non-empty spec string"); }
  const parsed = parseJson(spec);
  if (!Array.isArray(parsed) || parsed.length !== 5) { throw new RangeError("runCursorChild received a malformed spec: expected a 5-element JSON array"); }
  const sdkModule: unknown = parsed.at(0);
  const graceMs: unknown = parsed.at(1);
  const electron: unknown = parsed.at(2);
  const taskkill: unknown = parsed.at(3);
  const marker: unknown = parsed.at(4);
  if (typeof sdkModule !== "string" || sdkModule.trim() === "") { throw new RangeError("runCursorChild spec sdkModule must be a non-empty string"); }
  if (typeof graceMs !== "number" || !Number.isFinite(graceMs) || graceMs < 0) { throw new RangeError("runCursorChild spec graceMs must be a non-negative finite number"); }
  if (!isValidElectronSpec(electron)) { throw new RangeError("runCursorChild spec electron must be a string, null, or false"); }
  if (taskkill !== null && typeof taskkill !== "string") { throw new RangeError("runCursorChild spec taskkill must be a string or null"); }
  if (typeof marker !== "string" || marker === "") { throw new RangeError("runCursorChild spec marker must be a non-empty string"); }
  return { sdkModule, graceMs, electron, taskkill, marker };
}

function postChildMessage(message: Record<string, unknown>): void {
  if (process.connected && typeof process.send === "function") { process.send(message); }
}

function clonePlain(value: unknown): unknown {
  if (value === undefined) { return undefined; }
  const encoded: unknown = JSON.stringify(value);
  return typeof encoded === "string" ? parseJson(encoded) : undefined;
}

function serializeChildError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) { return { name: "Error", message: String(error) }; }
  const out: Record<string, unknown> = {};
  for (const key of [...Object.keys(error), "code", "status", "operation", "isRetryable"]) {
    const field: unknown = Reflect.get(error, key);
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      out[key] = field;
    }
  }
  return { ...out, name: error.name, message: error.message };
}

function applyChildEnvironment(sdkModule: string, electron: string | null | false): void {
  if (electron === null) { delete process.env.ELECTRON_RUN_AS_NODE; }
  else if (typeof electron === "string") { process.env.ELECTRON_RUN_AS_NODE = electron; }
  try {
    const sdkPrefix = ["@cursor", "sdk"].join("/");
    const companionPkg = `${sdkPrefix}-${process.platform}-${process.arch}/package.json`;
    const root = path.dirname(createRequire(sdkModule).resolve(companionPkg));
    process.env.CURSOR_TREE_SITTER_VENDOR_DIR ??= path.join(root, "vendor");
    process.env.CURSOR_RIPGREP_PATH ??= path.join(root, "bin", process.platform === "win32" ? "rg.exe" : "rg");
  } catch { /* Companion optional for fake SDKs or preconfigured environments. */ }
}

function getProperty(target: unknown, key: string | symbol): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) { return undefined; }
  return Reflect.get(target, key);
}

function invokeSync(target: unknown, method: string | symbol, args: readonly unknown[]): unknown {
  const fn = getProperty(target, method);
  if (typeof fn !== "function") { throw new TypeError(`cursor child target has no method ${String(method)}`); }
  return Reflect.apply(fn, target, [...args]);
}

async function invokeMethod(target: unknown, method: string | symbol, args: readonly unknown[]): Promise<unknown> {
  const result: unknown = await invokeSync(target, method, args);
  return result;
}

async function runAgentClose(agent: unknown): Promise<void> {
  const dispose = getProperty(agent, Symbol.asyncDispose);
  await (typeof dispose === "function" ? invokeMethod(agent, Symbol.asyncDispose, []) : invokeMethod(agent, "close", []));
}

function requireEntry(map: ReadonlyMap<unknown, unknown>, key: unknown, label: string): unknown {
  const value = map.get(key);
  if (value === undefined) { throw new Error(`cursor ${label} handle not found`); }
  return value;
}

async function stopStream(entry: { return?: () => unknown } | undefined): Promise<void> {
  try { await entry?.return?.(); } catch { /* Best-effort stream close. */ }
}

async function streamRunEvents(state: ChildRuntimeState, id: number, runKey: unknown): Promise<void> {
  const run = requireEntry(state.runs, runKey, "run");
  // Obtain and register the iterator synchronously before the first await so an immediate `unstream` never misses it.
  const iterable = invokeSync(run, "stream", []);
  const iterator = invokeSync(iterable, Symbol.asyncIterator, []);
  const returnFn = getProperty(iterator, "return");
  state.streams.set(id, typeof returnFn === "function" ? { return: (): unknown => Reflect.apply(returnFn, iterator, []) } : {});
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Streaming SDK messages sequentially over IPC.
      const step = await invokeMethod(iterator, "next", []);
      if (getProperty(step, "done") === true) { return; }
      postChildMessage({ t: "event", id, v: clonePlain(getProperty(step, "value")) });
    }
  } finally { state.streams.delete(id); }
}

async function runSdkLogin(state: ChildRuntimeState, id: number): Promise<void> {
  state.abort = new AbortController();
  const store = {
    load: async (): Promise<undefined> => { await Promise.resolve(); },
    clear: async (): Promise<never> => { await Promise.resolve(); throw new Error("oar's cursor login never clears the stored login"); },
    save: async (credentials: unknown): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        state.pending = { credentials, resolve, reject };
        postChildMessage({ t: "event", id, v: { save: true } });
      });
    },
  };
  const auth = getProperty(getProperty(state.sdk, "Cursor"), "auth");
  await invokeMethod(auth, "login", [{
    openBrowser: false,
    signal: state.abort.signal,
    onLoginUrl: (url: unknown): void => { postChildMessage({ t: "event", id, v: { url } }); },
    store,
  }]);
}

async function commitSdkLogin(state: ChildRuntimeState): Promise<void> {
  const pending = state.pending;
  if (pending === undefined) { throw new Error("no pending cursor login to commit"); }
  const { credentials } = pending;
  pending.credentials = undefined;
  const StoreCtor = getProperty(state.sdk, "FileCredentialStore");
  if (typeof StoreCtor !== "function") { throw new TypeError("cursor SDK does not export FileCredentialStore"); }
  const instance: unknown = Reflect.construct(StoreCtor, []);
  await invokeMethod(instance, "save", [credentials]);
}

type ChildCallHandler = (id: number, ...args: unknown[]) => unknown;

function createCallHandlers(state: ChildRuntimeState, shutdown: (code: number) => Promise<void>): Record<string, ChildCallHandler> {
  const registerAgent = async (id: number, opening: Promise<unknown>): Promise<Record<string, unknown>> => {
    const agent = await opening;
    state.agents.set(id, agent);
    return { agentId: getProperty(agent, "agentId"), model: getProperty(agent, "model"), summarize: typeof getProperty(agent, "summarize") === "function" };
  };
  const registerRun = async (id: number, starting: Promise<unknown>): Promise<Record<string, unknown>> => {
    const run = await starting;
    state.runs.set(id, run);
    return { runId: getProperty(run, "id"), steer: typeof getProperty(run, "steer") === "function" };
  };
  return {
    models: async (_id, options) => { const v = await invokeMethod(getProperty(getProperty(state.sdk, "Cursor"), "models"), "list", [options]); return v; },
    listRuns: async (_id, agentId, options) => { const v = await invokeMethod(getProperty(state.sdk, "Agent"), "listRuns", [agentId, options]); return v; },
    create: async (id, options) => { const v = await registerAgent(id, invokeMethod(getProperty(state.sdk, "Agent"), "create", [options])); return v; },
    resume: async (id, agentId, options) => { const v = await registerAgent(id, invokeMethod(getProperty(state.sdk, "Agent"), "resume", [agentId, options])); return v; },
    send: async (id, agentKey, message, local) => {
      const options: Record<string, unknown> = {
        onDelta: ({ update }: { readonly update: unknown }): void => { postChildMessage({ t: "event", id, v: clonePlain(update) }); },
        ...(local !== undefined && local !== null ? { local } : {}),
      };
      const v = await registerRun(id, invokeMethod(requireEntry(state.agents, agentKey, "agent"), "send", [message, options]));
      return v;
    },
    summarize: async (id, agentKey) => { const v = await registerRun(id, invokeMethod(requireEntry(state.agents, agentKey, "agent"), "summarize", [])); return v; },
    close: async (_id, key) => {
      const agent = state.agents.get(key);
      state.agents.delete(key);
      if (agent !== undefined) {
        const done = runAgentClose(agent);
        state.closing.add(done);
        await done;
      }
    },
    shutdown: () => { void shutdown(0); },
    wait: async (_id, runKey) => { const v = await invokeMethod(requireEntry(state.runs, runKey, "run"), "wait", []); return v; },
    cancel: async (_id, runKey) => { const v = await invokeMethod(requireEntry(state.runs, runKey, "run"), "cancel", []); return v; },
    steer: async (_id, runKey, text) => {
      const ack = await invokeMethod(requireEntry(state.runs, runKey, "run"), "steer", [text]);
      // Do not iterate `ack` keys or access optional getters like `ack.run` (SDK 1.4.x queued cloud run).
      return getProperty(ack, "outcome") === "queued" ? { outcome: "queued" } : ack;
    },
    stream: async (id, runKey) => { await streamRunEvents(state, id, runKey); },
    unstream: (_id, streamId) => { void stopStream(state.streams.get(streamId)); },
    status: async () => { const v = await invokeMethod(getProperty(getProperty(state.sdk, "Cursor"), "auth"), "status", []); return v; },
    logout: async () => { await invokeMethod(getProperty(getProperty(state.sdk, "Cursor"), "auth"), "logout", []); },
    login: async (id) => { await runSdkLogin(state, id); },
    abortLogin: () => { state.abort?.abort(); },
    commit: async () => { await commitSdkLogin(state); },
    saved: () => { state.pending?.resolve(); },
    refused: (_id, message) => { state.pending?.reject(new Error(String(message))); },
  };
}

async function loadCursorSdkIntoChild(sdkModule: string, state: ChildRuntimeState): Promise<void> {
  try {
    // Variable specifier prevents bundlers (e.g. esbuild in Node SEA) from rewriting or aliasing `@cursor/sdk`.
    const specifier = sdkModule;
    const loaded: unknown = await import(specifier);
    state.sdk = loaded;
    const auth = getProperty(getProperty(loaded, "Cursor"), "auth");
    postChildMessage({
      t: "ready",
      v: {
        auth: auth !== undefined,
        logout: typeof getProperty(auth, "logout") === "function",
        store: typeof getProperty(loaded, "FileCredentialStore") === "function",
      },
    });
  } catch (error) {
    postChildMessage({ t: "ready", e: serializeChildError(error) });
  }
}

/**
 * Run OAR's Cursor SDK subprocess protocol inside a host-launched child process
 * (paired with `CursorSubprocessOptions.childProcess`).
 *
 * Takes over the current process: validates IPC and `spec` synchronously, hooks
 * `process` IPC messages, `SIGTERM`, `disconnect`, `uncaughtException`, and
 * `exit`, and calls `process.exit` when the host shuts the child down or dies.
 * Never call this in the parent process.
 */
export function runCursorChild(spec: string): void {
  if (typeof process.send !== "function") {
    throw new TypeError("runCursorChild must be called in a child process with a Node IPC channel (process.send is unavailable)");
  }
  const parsed = parseCursorChildSpec(spec);
  applyChildEnvironment(parsed.sdkModule, parsed.electron);

  const state: ChildRuntimeState = {
    sdk: undefined, pending: undefined, abort: undefined,
    agents: new Map(), closing: new Set(), runs: new Map(), streams: new Map(),
  };

  const { shutdown } = installIpcChildGuards({
    graceMs: parsed.graceMs,
    taskkill: parsed.taskkill,
    marker: parsed.marker,
    closeAll: () => {
      for (const agent of state.agents.values()) { state.closing.add(runAgentClose(agent)); }
      state.agents.clear();
      return [...state.closing];
    },
  });

  const handlers = createCallHandlers(state, shutdown);
  process.on("message", (raw: unknown) => {
    const record = asRecord(raw);
    const id = typeof record?.id === "number" ? record.id : -1;
    const method = typeof record?.m === "string" ? record.m : "";
    const args: readonly unknown[] = Array.isArray(record?.a) ? record.a : [];
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    void (async (): Promise<void> => {
      try {
        if (handler === undefined) { throw new Error(`unknown cursor child method: ${method}`); }
        postChildMessage({ t: "reply", id, v: clonePlain(await handler(id, ...args)) });
      } catch (error) {
        postChildMessage({ t: "reply", id, e: serializeChildError(error) });
      }
    })();
  });

  void loadCursorSdkIntoChild(parsed.sdkModule, state);
}
