import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { record } from "./trace.js";

// This limits fixture housekeeping, not session disposal or a native deadline.
const waitMs = 5000;

/** A private fixture home can finish deletion after its test has moved on. */
export async function removeCodexHome(home: string): Promise<void> {
  const started = performance.now();
  const state = { pending: false };
  function report(outcome: "pending" | "removed" | "failed", error?: unknown): void {
    const entry = {
      kind: "codex_home_cleanup", home, outcome, elapsedMs: performance.now() - started,
      waitMs, residue: outcome === "removed" ? "removed" : "unconfirmed",
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : (typeof error === "string" ? error : "Unknown directory-removal error") }),
    };
    // The home identity remains useful if a late callback reaches a later trace.
    // A pending removal does not establish which files or processes remain.
    try { record(entry); } catch { /* Keep the independent job-log diagnostic. */ }
    try { process.stderr.write(`${JSON.stringify(entry)}\n`); } catch { /* A closed log cannot change the native result. */ }
  }
  const removal = (async (): Promise<void> => {
    try {
      // codex leaves background writers (plugins clone) briefly alive after
      // dispose; retain retries for that case. This does not establish the
      // cause of any particular slow or refused removal.
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (state.pending) { report("removed"); }
    } catch (error) { report("failed", error); }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => { state.pending = true; report("pending"); resolve(); }, waitMs);
  });
  try { await Promise.race([removal, deadline]); }
  finally { clearTimeout(timer); }
}
