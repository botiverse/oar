import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AppServerClient } from "./app-server-client.js";

interface InitializingHome { readonly waiting: Set<() => void> }
const initializing = new Map<string, InitializingHome>();
// Only an observed successful handshake establishes readiness. Directory
// identity invalidates it when a host replaces a temporary home at the same path.
const initialized = new Map<string, string>();

function homePath(env: NodeJS.ProcessEnv, cwd: string): string {
  const userHome = process.platform === "win32" ? homedir() : env.HOME;
  const fallback = path.join(userHome === undefined || userHome === "" ? homedir() : userHome, ".codex");
  const configured = env.CODEX_HOME;
  const directory = path.resolve(cwd, configured === undefined || configured === "" ? fallback : configured);
  try { return realpathSync(directory); } catch { return directory; }
}

function identity(home: string): string | null {
  try {
    const stat = statSync(home);
    return stat.isDirectory() ? `${String(stat.dev)}:${String(stat.ino)}:${String(stat.birthtimeMs)}` : null;
  } catch { return null; }
}

/** A queued reader's existing deadline can cancel it before any process starts. */
function queuedClient(state: InitializingHome, start: () => AppServerClient): AppServerClient {
  const ready = Promise.withResolvers<AppServerClient>();
  const subscriptions: ((client: AppServerClient) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  let actual: AppServerClient | null = null;
  let cancelled = false;
  let handled = false;
  async function spawned(): Promise<void> { const client = await ready.promise; await client.spawned; }
  async function exited(): Promise<number | null> {
    try { const client = await ready.promise; const code = await client.exited; return code; } catch { return null; }
  }
  const spawn = spawned();
  // Requests normally observe this failure; retain spawned's rejection for
  // explicit callers without creating an unhandled parallel promise.
  // oxlint-disable-next-line promise/prefer-await-to-then
  void spawn.catch(() => {});
  const exit = exited();
  const begin = (): void => {
    if (cancelled) { return; }
    try {
      actual = start();
      for (const subscribe of subscriptions.splice(0)) { subscribe(actual); }
      exitHandlers.length = 0;
      ready.resolve(actual);
    } catch (error) {
      ready.reject(error);
      for (const handler of exitHandlers.splice(0)) { handler(null); }
    }
  };
  state.waiting.add(begin);
  const subscribe = (callback: (client: AppServerClient) => void): void => {
    if (actual !== null) { callback(actual); } else if (!cancelled) { subscriptions.push(callback); }
  };
  return {
    spawned: spawn, exited: exit,
    async request(method, params, onSettled) {
      let client: AppServerClient | null = null;
      try { client = await ready.promise; } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        onSettled?.({ kind: "error", error: failure });
        throw failure;
      }
      return client.request(method, params, onSettled);
    },
    notify(method, params) { subscribe((client) => { client.notify(method, params); }); },
    handle(handlers) {
      if (handled) { throw new Error("app-server handlers are already registered"); }
      handled = true;
      subscribe((client) => { client.handle(handlers); });
    },
    mark(callback) { subscribe((client) => { client.mark(callback); }); },
    onExit(handler) {
      if (cancelled) { queueMicrotask(() => { handler(null); }); return; }
      if (actual === null) { exitHandlers.push(handler); }
      subscribe((client) => { client.onExit(handler); });
    },
    kill() {
      if (actual !== null) { actual.kill(); return; }
      if (cancelled) { return; }
      cancelled = true;
      state.waiting.delete(begin);
      subscriptions.length = 0;
      ready.reject(new Error("Codex app-server startup cancelled before spawn"));
      for (const handler of exitHandlers.splice(0)) { handler(null); }
    },
    // No process yet (waiting its turn to initialize the home), or none any more: nothing to read.
    resources: async () => {
      const reading = actual === null ? null : await actual.resources();
      return reading;
    },
  };
}

/** Coordinate first initialization among this module's app-server clients only. */
export function coordinateHomeInitialization(
  env: NodeJS.ProcessEnv,
  cwd: string,
  create: () => AppServerClient,
): AppServerClient {
  const home = homePath(env, cwd);
  const active = initializing.get(home);
  if (active !== undefined) {
    return queuedClient(active, () => coordinateHomeInitialization(env, cwd, create));
  }
  const current = identity(home);
  if (current !== null && initialized.get(home) === current) { return create(); }
  initialized.delete(home);
  const state: InitializingHome = { waiting: new Set() };
  initializing.set(home, state);
  let released = false;
  const release = (success: boolean): void => {
    if (released) { return; }
    released = true;
    const observed = success ? identity(home) : null;
    if (observed !== null) { initialized.set(home, observed); }
    initializing.delete(home);
    for (const begin of state.waiting) { begin(); }
    state.waiting.clear();
  };
  const createOwner = (): AppServerClient => {
    try { return create(); } catch (error) { release(false); throw error; }
  };
  const client = createOwner();
  client.onExit(() => { release(false); });
  let accepted = false;
  return {
    ...client,
    async request(method, params, onSettled) {
      try {
        return await client.request(method, params, (outcome) => {
          if (method === "initialize" && outcome.kind === "result") { accepted = true; }
          onSettled?.(outcome);
        });
      } catch (error) {
        if (method === "initialize") { client.kill(); await client.exited; release(false); }
        throw error;
      }
    },
    notify(method, params) {
      client.notify(method, params);
      if (method === "initialized" && accepted) { release(true); }
    },
  };
}
