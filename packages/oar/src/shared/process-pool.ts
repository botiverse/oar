import type { SessionResources } from "../contracts/session.js";

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
  /** Bounded native/process shutdown. Called only after the last lease is disposed. */
  stop(this: void): void | Promise<void>;
  resources(this: void): Promise<SessionResources | null>;
}

export interface ProcessLease<T extends PooledProcess> {
  readonly process: T;
  readonly placement: "shared" | "isolated";
  /** Idempotent; released means peers still own the process, exited means shutdown was observed. */
  dispose(this: void): Promise<"released" | "exited">;
  resources(this: void): Promise<SessionResources | null>;
}

function configurationKey(config: ProcessConfiguration): string {
  return JSON.stringify([config.command, config.args, Object.entries(config.env).toSorted(([a], [b]) => a.localeCompare(b)),
    config.home, config.configDirectories, config.cwd]);
}

interface Entry<T> {
  readonly ready: Promise<T>;
  leases: number;
  exited: boolean;
}

/** One runtime instance's pool. Nothing is global, restarted, or keyed by a runtime name. */
export function createProcessPool<T extends PooledProcess>(start: (configuration: ProcessConfiguration) => Promise<T>): {
  acquire(configuration: ProcessConfiguration, placement: "shared" | "isolated"): Promise<ProcessLease<T>>;
} {
  const entries = new Map<string, Entry<T>>();
  return {
    async acquire(configuration, placement) {
      // Snapshot before the asynchronous start so the key and process inputs cannot diverge.
      const captured: ProcessConfiguration = { ...configuration, args: [...configuration.args], env: { ...configuration.env },
        ...(configuration.configDirectories === undefined ? {} : { configDirectories: [...configuration.configDirectories] }) };
      const key = configurationKey(captured);
      let entry = placement === "shared" ? entries.get(key) : undefined;
      if (entry === undefined) {
        // Defer start until the entry has been installed: concurrent opens join its promise.
        entry = { ready: (async (): Promise<T> => { await Promise.resolve(); return start(captured); })(), leases: 0, exited: false };
        if (placement === "shared") { entries.set(key, entry); }
        const created = entry;
        const remove = (): void => { if (entries.get(key) === created) { entries.delete(key); } };
        void (async (): Promise<void> => {
          try { const process = await created.ready; await process.exited; }
          catch { /* Startup failure is delivered to each acquire caller. */ }
          finally { created.exited = true; remove(); }
        })();
      }
      entry.leases += 1;
      const owned = entry;
      const process = await owned.ready;
      const hasExited = (): boolean => owned.exited;
      let disposal: Promise<"released" | "exited"> | null = null;
      return {
        process, placement,
        async dispose() {
          disposal ??= (async (): Promise<"released" | "exited"> => {
            owned.leases -= 1;
            if (hasExited()) { return "exited"; }
            if (owned.leases !== 0) { return "released"; }
            // Remove before stopping. A concurrent new open gets a fresh process;
            // an open already joining this one reserved its lease before awaiting start.
            if (entries.get(key) === owned) { entries.delete(key); }
            await process.stop();
            await process.exited;
            return "exited";
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
    },
  };
}
