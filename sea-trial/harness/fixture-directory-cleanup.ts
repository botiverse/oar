import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { record } from "./trace.js";
import { snapshotFixtureProcesses } from "./fixture-process-snapshot.js";

// This limits fixture housekeeping, not session disposal or a native deadline.
const waitMs = 5000;

function write(entry: Record<string, unknown>): void {
  try { record(entry); } catch { /* Keep the independent job-log diagnostic. */ }
  try { process.stderr.write(`${JSON.stringify(entry)}\n`); } catch { /* A closed log cannot change the native result. */ }
}

async function observeProcesses(directory: string, purpose: string): Promise<void> {
  if (process.platform !== "win32" || process.env.OAR_TEST !== "codex-aimock") { return; }
  const started = performance.now();
  const identity = { kind: "fixture_directory_processes", directory, purpose, observerPid: process.pid, startedAt: Date.now() };
  // Independent of removal and its waiter. A late result retains this directory.
  try { write({ ...identity, ...await snapshotFixtureProcesses(), elapsedMs: performance.now() - started }); }
  catch { write({ ...identity, outcome: "failed", reason: "observer", elapsedMs: performance.now() - started }); }
}

/** A private fixture directory can finish deletion after its test has moved on. */
export async function removeFixtureDirectory(directory: string, purpose: string): Promise<void> {
  const started = performance.now();
  const state = { pending: false };
  function report(outcome: "pending" | "removed" | "failed", error?: unknown): void {
    const entry = {
      kind: "fixture_directory_cleanup", directory, purpose, outcome, elapsedMs: performance.now() - started,
      waitMs, residue: outcome === "removed" ? "removed" : "unconfirmed",
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : (typeof error === "string" ? error : "Unknown directory-removal error") }),
    };
    // The directory identity remains useful if a late callback reaches a later trace.
    // A pending removal does not establish which files or processes remain.
    write(entry);
  }
  const removal = (async (): Promise<void> => {
    try {
      // Keep the existing bounded retry policy. A slow or refused removal
      // does not by itself identify a remaining process or file lock.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (state.pending) { report("removed"); }
    } catch (error) { report("failed", error); }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => { state.pending = true; report("pending"); void observeProcesses(directory, purpose); resolve(); }, waitMs);
  });
  try { await Promise.race([removal, deadline]); }
  finally { clearTimeout(timer); }
}
