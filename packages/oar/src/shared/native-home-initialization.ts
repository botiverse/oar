import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type FinishInitialization = (ready: boolean) => void;
export interface WaitingForInitialization { readonly subscribe: (wake: () => void) => () => void }
type Admission = "ready" | FinishInitialization | WaitingForInitialization;

/** A native home may be missing while an existing ancestor already has aliases. */
export function canonicalHomePath(directory: string): string {
  try { return realpathSync.native(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") { throw error; }
    const parent = dirname(directory);
    if (parent === directory) { throw error; }
    return join(canonicalHomePath(parent), basename(directory));
  }
}

/** One coordinator per runtime. Only a native handshake can mark this filesystem object ready. */
export class NativeHomeInitialization {
  private readonly starting = new Map<string, Set<() => void>>();
  private readonly initialized = new Map<string, string>();
  constructor(private readonly manifest?: string) {}

  private identity(home: string): string | null {
    try {
      const stat = statSync(this.manifest === undefined ? home : join(home, this.manifest));
      if (this.manifest === undefined ? !stat.isDirectory() : !stat.isFile()) { return null; }
      return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.birthtimeMs)}`;
    } catch { return null; }
  }

  /** Synchronous admission for an already resolved native home. */
  enter(home: string): Admission {
    const key = process.platform === "win32" ? home.toLowerCase() : home;
    const active = this.starting.get(key);
    if (active !== undefined) {
      return { subscribe(wake) { active.add(wake); return () => { active.delete(wake); }; } };
    }
    const identity = this.identity(home);
    if (identity !== null && identity === this.initialized.get(key)) { return "ready"; }
    this.initialized.delete(key);
    const waiting = new Set<() => void>();
    this.starting.set(key, waiting);
    return ready => {
      if (this.starting.get(key) !== waiting) { return; }
      const observed = ready ? this.identity(home) : null;
      if (observed !== null) { this.initialized.set(key, observed); }
      this.starting.delete(key);
      for (const wake of waiting) { wake(); }
      waiting.clear();
    };
  }

  async acquire(directory: string, signal: AbortSignal): Promise<FinishInitialization> {
    for (;;) {
      signal.throwIfAborted();
      const admission = this.enter(canonicalHomePath(directory));
      if (admission === "ready") { return () => {}; }
      if (typeof admission === "function") { return admission; }
      // oxlint-disable-next-line no-await-in-loop -- A failed owner hands initialization to one waiter.
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = admission.subscribe(() => { signal.removeEventListener("abort", abort); resolve(); });
        const abort = (): void => { unsubscribe(); reject(signal.reason instanceof Error ? signal.reason : new Error("Native home initialization cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
