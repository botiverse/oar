import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Test artifacts, not scratch files. One RUN (a sea-trial invocation, or an
 * all.ts batch, or a CI job) owns one directory; every backend in that run
 * gets a subdirectory holding everything about it. Deterministic layout:
 *
 *   <run-dir>/                 OAR_TRIAL_RUN_DIR, or ./oar-trial-run/run-<iso stamp> (gitignored)
 *     <backend>/trace.jsonl    case boundaries + every session event
 *     <backend>/output.log     full process output (written by all.ts)
 *     report.json              batch summary (written by all.ts)
 *
 * all.ts and CI set OAR_TRIAL_RUN_DIR so all backends of one run land
 * together; a bare `pnpm sea-trial` mints its own run directory.
 */

export function resolveRunDir(): string {
  const configured = process.env.OAR_TRIAL_RUN_DIR;
  const dir = configured ?? path.join(
    process.cwd(),
    "oar-trial-run",
    `run-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

let traceFile: string | null = null;

export function openTrace(backend: string): string {
  const dir = path.join(resolveRunDir(), backend);
  mkdirSync(dir, { recursive: true });
  traceFile = path.join(dir, "trace.jsonl");
  record({ kind: "run_started", backend });
  return traceFile;
}

export function record(entry: Record<string, unknown>): void {
  if (traceFile === null) {
    return;
  }
  appendFileSync(traceFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}
