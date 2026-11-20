import { homedir } from "node:os";
import path from "node:path";
import type { CancellationObservation } from "../../shared/executable/process-cancellation.js";
import { environmentValue } from "../../shared/environment.js";
import { canonicalHomePath, NativeHomeInitialization, type WaitingForInitialization } from "../../shared/native-home-initialization.js";
import type { AppServerClient } from "./app-server-client.js";

const homes = new NativeHomeInitialization();

export function codexHomePath(
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathLib = platform === "win32" ? path.win32 : path;
  const userHome = environmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform);
  const fallback = pathLib.join(userHome === undefined || userHome === "" ? homedir() : userHome, ".codex");
  const configured = environmentValue(env, "CODEX_HOME", platform);
  const directory = pathLib.resolve(cwd, configured === undefined || configured === "" ? fallback : configured);
  if (platform !== process.platform) { return directory; }
  try { return canonicalHomePath(directory); } catch { return directory; }
}

/** A queued reader's existing deadline can cancel it before any process starts. */
function queuedClient(state: WaitingForInitialization, start: () => AppServerClient): AppServerClient {
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
  const unsubscribe = state.subscribe(begin);
  const subscribe = (callback: (client: AppServerClient) => void): void => {
    if (actual !== null) { callback(actual); } else if (!cancelled) { subscriptions.push(callback); }
  };
  const stop = (): void => {
    if (actual !== null) { actual.kill(); return; }
    if (cancelled) { return; }
    cancelled = true;
    unsubscribe();
    subscriptions.length = 0;
    ready.reject(new Error("Codex app-server startup cancelled before spawn"));
    for (const handler of exitHandlers.splice(0)) { handler(null); }
  };
  return {
    spawned: spawn, exited: exit,
    rootPid: () => actual?.rootPid(),
    async observeCancellation() {
      const observation: CancellationObservation = actual === null ? { commit() {}, complete() {} } : await actual.observeCancellation();
      return observation;
    },
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
    respond(id, reply) { subscribe((client) => { client.respond(id, reply); }); },
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
    async close() {
      if (actual !== null) {
        if (actual.close !== undefined) { await actual.close(); }
        else { actual.kill(); await actual.exited; }
        return;
      }
      stop();
      await exit;
    },
    kill: stop,
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
  const home = codexHomePath(env, cwd);
  const release = homes.enter(home);
  if (release === "ready") { return create(); }
  if (typeof release !== "function") { return queuedClient(release, () => coordinateHomeInitialization(env, cwd, create)); }
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
