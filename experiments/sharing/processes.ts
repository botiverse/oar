/** Observe native command ownership without using the process tree to stop it. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readProcessTable, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";

export function identities(pids: readonly number[]): ProcessEntry[] {
  const table = readProcessTable();
  assert.ok(table.has(process.pid), "process table observation failed");
  return pids.map((pid) => { const entry = table.get(pid); assert.ok(entry, `missing process ${String(pid)}`); return entry; });
}

export function running(entries: readonly ProcessEntry[]): number[] {
  const table = readProcessTable();
  assert.ok(table.has(process.pid), "process table observation failed");
  return entries.filter((entry) => {
    if (table.get(entry.pid)?.start !== entry.start) { return false; }
    if (process.platform !== "linux") { return true; }
    try {
      const stat = readFileSync(`/proc/${String(entry.pid)}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  }).map((entry) => entry.pid);
}
