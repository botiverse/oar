import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/* oxlint-disable promise/prefer-await-to-then, promise/always-return, typescript/promise-function-async -- Observe settlement while returning the original promise. */
type Fields = Readonly<Record<string, unknown>>;
let context: () => Fields = () => ({});
let sequence = 0;

function readContext(): Fields {
  try { return { ...context() }; } catch { return { contextUnavailable: true }; }
}

/** Only the manual Codex experiment enables these payload-free diagnostics. */
export function setCodexPhaseContext(read: () => Fields): void { context = read; }

export function codexPhaseRecord(kind: string, fields: Fields = {}): void {
  const directory = process.env.OAR_CODEX_PHASES;
  if (directory === undefined) { return; }
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, `phases-${process.pid}.jsonl`), `${JSON.stringify({
      at: new Date().toISOString(), monotonicMs: performance.now(), pid: process.pid,
      workerId: process.env.VITEST_WORKER_ID ?? null, poolId: process.env.VITEST_POOL_ID ?? null,
      ...readContext(), kind, ...fields,
    })}\n`);
  } catch {
    // Sampling cannot turn a native result into a different test outcome.
    try { process.stderr.write("codex phase diagnostic write failed\n"); } catch { /* Closed pipe. */ }
  }
}

/** A missing end is an evidence gap, not proof that the phase hung. */
export function startCodexPhase(phase: string): (fields?: Fields) => void {
  if (process.env.OAR_CODEX_PHASES === undefined) { return () => {}; }
  const id = ++sequence;
  const started = performance.now();
  const origin = readContext();
  codexPhaseRecord("phase_start", { ...origin, phase, id });
  return (fields = {}) => { codexPhaseRecord("phase_end", { ...origin, phase, id, elapsedMs: performance.now() - started, ...fields }); };
}

/** Observe settlement without replacing the promise or changing its rejection. */
export function observeCodexPhase<T>(phase: string, invoke: () => Promise<T>): Promise<T> {
  const end = startCodexPhase(phase);
  try {
    const pending = invoke();
    void pending.then(() => { end({ outcome: "fulfilled" }); }, () => { end({ outcome: "rejected" }); });
    return pending;
  } catch (error) { end({ outcome: "threw" }); throw error; }
}
