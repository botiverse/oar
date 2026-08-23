import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Run trace: every session event and case boundary of one sea-trial run,
 * appended as JSONL. When a case fails, the mid-run trajectory is already on
 * disk — tracing for tests, not printf-after-the-fact. Location:
 * OAR_TRACE_DIR (default: <tmp>/oar-sea-trial), one file per run.
 */

let traceFile: string | null = null;

export function openTrace(backend: string): string {
  const dir = process.env.OAR_TRACE_DIR ?? path.join(tmpdir(), "oar-sea-trial");
  mkdirSync(dir, { recursive: true });
  traceFile = path.join(dir, `${backend}-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.jsonl`);
  record({ kind: "run_started", backend });
  return traceFile;
}

export function record(entry: Record<string, unknown>): void {
  if (traceFile === null) {
    return;
  }
  appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}
