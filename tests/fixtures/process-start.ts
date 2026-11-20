import assert from "node:assert/strict";
import { observeProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";

/** Undefined means the PID was absent from a successful OS observation. */
export function processStart(pid: number): string | undefined {
  const observation = observeProcessTable();
  if (!observation.ok) { throw new Error(`Cannot read process table: ${observation.reason}`); }
  assert.ok(observation.unreadable?.has(pid) !== true, `Cannot identify process ${String(pid)}`);
  return observation.table.get(pid)?.start;
}

/** Capture inside the fixture child while it still owns the PID. */
export function currentProcessStart(): string {
  const start = processStart(process.pid);
  assert.ok(start !== undefined, "Missing fixture process start time");
  return start;
}
