import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { checkedProcessTable } from "../../../experiments/sharing/process-table.js";
import { parseProcessStat, type ProcessEntry, type ProcessTable } from "../../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";

/** State and creation identity come from the same read, never a reused PID. */
export function linuxProcessState(entry: ProcessEntry): string | null {
  let stat = "";
  try { stat = readFileSync(`/proc/${String(entry.pid)}/stat`, "utf8"); }
  catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT" || code === "ESRCH") { return null; }
    throw error;
  }
  if (parseProcessStat(entry.pid, stat).start !== entry.start) { return null; }
  const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  if (state === undefined || !/^[A-Za-z]$/u.test(state)) { throw new Error("Invalid Linux process state"); }
  return state;
}

interface ObservedProcess extends ProcessEntry { readonly state: string | null; }
interface Snapshot { readonly at: string; readonly elapsedMs: number; readonly processes: readonly ObservedProcess[]; }
interface Settlement {
  readonly table: ProcessTable;
  readonly remaining: readonly ObservedProcess[];
  readonly zombies: readonly ObservedProcess[];
  readonly snapshots: readonly Snapshot[];
  readonly elapsedMs: number;
  readonly waitMs: number;
}

function present(entries: readonly ProcessEntry[], table: ProcessTable): ObservedProcess[] {
  return entries.flatMap(entry => {
    const current = table.get(entry.pid);
    if (current?.start !== entry.start) { return []; }
    try { process.kill(entry.pid, 0); }
    catch (error) { if (asRecord(error)?.code === "ESRCH") { return []; } throw error; }
    const state = process.platform === "linux" ? linuxProcessState(current) : null;
    if (process.platform === "linux" && state === null) { return []; }
    return [{ ...current, state }];
  });
}

/** Exit records follow signal dispatch, not the OS's completion of descendant exit/reaping. */
export async function settleObservedProcesses(entries: readonly ProcessEntry[], initial: ProcessTable): Promise<Settlement> {
  const waitMs = 2000;
  const started = performance.now();
  const snapshots: Snapshot[] = [];
  const zombies = new Map<string, ObservedProcess>();
  let table = initial;
  let current = present(entries, table);
  let previous = "";
  const record = (): void => {
    for (const entry of current) { if (entry.state === "Z") { zombies.set(`${String(entry.pid)}:${entry.start}`, entry); } }
    const signature = JSON.stringify(current);
    if (signature !== previous) {
      snapshots.push({ at: new Date().toISOString(), elapsedMs: performance.now() - started, processes: current });
      previous = signature;
    }
  };
  record();
  while (current.some(entry => entry.state !== "Z") && performance.now() - started < waitMs) {
    const remainingMs = Math.max(0, waitMs - (performance.now() - started));
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded observation of processes already stopped by OAR; no signals during this window.
    await delay(Math.min(25, remainingMs));
    table = checkedProcessTable("opencode-fixture-settle", process.platform, true);
    current = present(entries, table); record();
  }
  if (current.some(entry => entry.state !== "Z")) {
    // Liveness and state reads cannot authorize a signal to a later PID owner.
    table = checkedProcessTable("opencode-fixture-revalidate", process.platform, true);
    current = current.flatMap(entry => {
      if (table.get(entry.pid)?.start !== entry.start) { return []; }
      const state = process.platform === "linux" ? linuxProcessState(entry) : null;
      if (process.platform === "linux" && state === null) { return []; }
      return [{ ...entry, state }];
    }); record();
  }
  return { table, remaining: current.filter(entry => entry.state !== "Z"), zombies: [...zombies.values()],
    snapshots, elapsedMs: performance.now() - started, waitMs };
}
