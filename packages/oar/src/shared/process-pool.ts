import { createHash } from "node:crypto";
import type { SessionResources, Unsubscribe } from "../contracts/session.js";

/** Fully resolved process inputs, captured at open. Never put these values in records. */
export interface ProcessConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  /** Include inherited values as well as the requested overlay, so host changes cannot reuse stale state. */
  readonly env: Readonly<Record<string, string | null>>;
  readonly home?: string;
  readonly configDirectories?: readonly string[];
  /** Set only for a process-level cwd, not a protocol's session-level cwd. */
  readonly cwd?: string;
}

export interface PooledProcess {
  /** Resolves once at actual process exit, including unexpected exits; never rejects. */
  readonly exited: Promise<number | null>;
  /** Bounded native/process shutdown. Called only after the last lease is disposed. May be retried after failure. */
  stop(this: void): void | Promise<void>;
  resources(this: void): Promise<SessionResources | null>;
}

export interface ProcessLease<T extends PooledProcess> {
  readonly process: T;
  readonly placement: "shared" | "isolated";
  /** Remove the observer when a session releases its lease; a shared process must not retain it. */
  onExit(listener: (code: number | null) => void): Unsubscribe;
  /** Concurrent calls coalesce. A failed stop retains ownership and can be retried. */
  dispose(this: void): Promise<"released" | "exited">;
  resources(this: void): Promise<SessionResources | null>;
}

function configurationKey(config: ProcessConfiguration): string {
  const values = JSON.stringify([config.command, config.args, Object.entries(config.env).toSorted(([a], [b]) => a < b ? -1 : (a > b ? 1 : 0)),
    config.home, config.configDirectories, config.cwd]);
  return createHash("sha256").update(values).digest("hex");
}

interface Entry<T> {
  readonly ready: Promise<T>;
  readonly listeners: Set<(code: number | null) => void>;
  leases: number;
  exited: boolean;
  code: number | null;
}

async function observeExit<T extends PooledProcess>(entry: Entry<T>, remove: () => void): Promise<void> {
  try { const process = await entry.ready; entry.code = await process.exited; }
  catch { /* Startup failure is delivered to each acquire caller. */ }
  finally {
    entry.exited = true;
    remove();
    for (const listener of entry.listeners) {
      try { listener(entry.code); } catch { /* One observer cannot hide exit from its peers. */ }
    }
    entry.listeners.clear();
  }
}

function leaseOf<T extends PooledProcess>(process: T, owned: Entry<T>, placement: "shared" | "isolated", retire: () => void): ProcessLease<T> {
  let disposal: Promise<"released" | "exited"> | null = null;
  let surrendered = false;
  const hasExited = (): boolean => owned.exited;
  const dispose = async (): Promise<"released" | "exited"> => {
    if (!surrendered) { owned.leases -= 1; surrendered = true; }
    if (owned.exited) { return "exited"; }
    if (owned.leases !== 0) { return "released"; }
    // A new open must not join shutdown. Keep the retiring entry owned until
    // actual exit, including a failed stop whose last lease can retry.
    retire();
    await process.stop();
    await process.exited;
    return "exited";
  };
  return {
    process, placement,
    onExit(listener) {
      if (owned.exited) { listener(owned.code); return () => {}; }
      owned.listeners.add(listener);
      return () => { owned.listeners.delete(listener); };
    },
    async dispose() {
      disposal ??= (async (): Promise<"released" | "exited"> => {
        try { return await dispose(); } catch (error) { disposal = null; throw error; }
      })();
      const result = await disposal;
      return result;
    },
    async resources() {
      if (hasExited()) { return null; }
      const result = await process.resources();
      return hasExited() || result === null ? null : { ...result, ...(placement === "shared" ? { scope: "shared_process" as const } : {}) };
    },
  };
}

/** One runtime instance's pool. Nothing is global, restarted, or keyed by a runtime name. */
export function createProcessPool<T extends PooledProcess>(start: (configuration: ProcessConfiguration) => Promise<T>): {
  acquire(configuration: ProcessConfiguration, placement: "shared" | "isolated"): Promise<ProcessLease<T>>;
} {
  const entries = new Map<string, Entry<T>>();
  // Retain strong references to processes removed from acquisition during
  // shutdown, including failed stops. Only actual exit removes this ownership;
  // the last lease can retry shutdown without admitting new sessions.
  const retiring = new Set<Entry<T>>();
  return {
    async acquire(configuration, placement) {
      const captured: ProcessConfiguration = { ...configuration, args: [...configuration.args], env: { ...configuration.env },
        ...(configuration.configDirectories === undefined ? {} : { configDirectories: [...configuration.configDirectories] }) };
      const key = configurationKey(captured);
      let entry = placement === "shared" ? entries.get(key) : undefined;
      if (entry === undefined) {
        // Reserve before asynchronous start so concurrent opens join one promise.
        entry = { ready: (async (): Promise<T> => { await Promise.resolve(); return start(captured); })(), leases: 0, exited: false, code: null, listeners: new Set() };
        if (placement === "shared") { entries.set(key, entry); }
        const created = entry;
        void observeExit(created, () => { if (entries.get(key) === created) { entries.delete(key); } retiring.delete(created); });
      }
      entry.leases += 1;
      const owned = entry;
      const process = await owned.ready;
      return leaseOf(process, owned, placement, () => {
        if (entries.get(key) === owned) { entries.delete(key); }
        retiring.add(owned);
      });
    },
  };
}
