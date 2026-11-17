import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { kimiWebEndpoint, type WebEndpoint } from "./web-query.js";

interface Waiter { readonly grant: () => void }
const homes = new Map<string, Waiter[]>();

function canonical(directory: string): string {
  try { return realpathSync.native(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") { throw error; }
    const parent = dirname(directory);
    if (parent === directory) { throw error; }
    return join(canonical(parent), basename(directory));
  }
}

/**
 * Match native trim/nonempty acceptance; never retain or return the token.
 * Kimi 2.6.3: packages/kap-server/src/services/auth/persistentToken.ts:20-39
 * at b0de2fbd2de04d87689225aafd3912e5d193b62d.
 */
function tokenExists(home: string): boolean {
  try { return readFileSync(join(home, "server.token"), "utf8").trim().length > 0; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; }
    throw error;
  }
}

function ownership(home: string, waiters: Waiter[]): () => void {
  let released = false;
  return () => {
    if (released) { return; }
    released = true;
    const next = waiters.shift();
    if (next === undefined) { homes.delete(home); } else { next.grant(); }
  };
}

// oxlint-disable-next-line require-await -- Normalize immediate cancellation and queued ownership to one promise.
async function acquire(home: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const key = process.platform === "win32" ? home.toLowerCase() : home;
  const existing = homes.get(key);
  if (existing === undefined) {
    const waiters: Waiter[] = []; homes.set(key, waiters);
    return ownership(key, waiters);
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const index = existing.indexOf(waiter);
      if (index === -1) { return; }
      existing.splice(index, 1);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Kimi startup wait cancelled"));
    };
    const waiter: Waiter = { grant: () => { signal.removeEventListener("abort", abort); resolve(ownership(key, existing)); } };
    existing.push(waiter);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** First token creation only, within this OAR process; the caller owns the deadline. */
export async function acquireKimiWebStartup(env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const configured = environmentValue(env, "KIMI_CODE_HOME");
  const root = configured === undefined || configured === "" ? join(environmentHome(env), ".kimi-code") : configured;
  const home = canonical(resolvePath(cwd, root));
  if (tokenExists(home)) { return () => {}; }
  const release = await acquire(home, signal);
  try {
    signal.throwIfAborted();
    // The owner may have created the token while this caller was queued.
    if (tokenExists(home)) { release(); return () => {}; }
    return release;
  } catch (error) { release(); throw error; }
}

/** Release at native readiness or failure, while queries continue concurrently. */
export async function startKimiWeb(command: string, env: NodeJS.ProcessEnv, signal: AbortSignal, cwd = process.cwd()): Promise<{ child: LineProcess; web: WebEndpoint }> {
  const release = await acquireKimiWebStartup(env, cwd, signal);
  let child: LineProcess | null = null;
  let stopRequested = false;
  const stop = (): void => {
    if (child === null || stopRequested || child.stopping()) { return; }
    stopRequested = true;
    child.kill();
  };
  try {
    signal.throwIfAborted();
    child = spawnLineProcess(command, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], { cwd, env, killTree: true, inheritStderr: false });
    const owned = child;
    signal.addEventListener("abort", stop, { once: true });
    owned.onExit(() => { release(); signal.removeEventListener("abort", stop); });
    const ready = kimiWebEndpoint(owned, signal);
    // oxlint-disable-next-line promise/prefer-await-to-then -- Observe readiness rejection if spawning fails first.
    void ready.catch(() => {});
    await owned.spawned;
    const web = await ready;
    return { child: owned, web };
  } catch (error) {
    stop();
    if (child !== null) { await child.exited; }
    throw error;
  } finally { release(); }
}
