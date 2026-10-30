import { readdir, readFile } from "node:fs/promises";
import { asRecord } from "../json.js";
import { InvalidProcessTableError, parseProcessPs, parseProcessStat, parseProcessWindows, processTableFailure, type ProcessEntry, type ProcessTableObservation, type ProcessTableRead, type ProcessTableSource } from "./process-tree.js";
import { processTableCommand } from "./process-table-command.js";

const BATCH = 64;
export const processTableSource = (): ProcessTableSource => process.platform === "linux" ? "procfs" : (process.platform === "win32" ? "windows" : "ps");

async function readProcfs(): Promise<ProcessTableRead> {
  const names = await readdir("/proc");
  const listed = names.filter((name) => /^\d+$/u.test(name));
  const table = new Map<number, ProcessEntry>();
  let skipped = 0;
  const read = async (name: string): Promise<ProcessEntry | null> => {
    try { return parseProcessStat(Number(name), await readFile(`/proc/${name}/stat`, "utf8")); }
    catch (error) {
      const code = asRecord(error)?.code;
      if (code === "ENOENT" || code === "ESRCH") { return null; }
      if (code === "EACCES" || code === "EPERM") { skipped += 1; return null; }
      throw error;
    }
  };
  for (let offset = 0; offset < listed.length; offset += BATCH) {
    const entries = await Promise.all(listed.slice(offset, offset + BATCH).map(async (name) => { const entry = await read(name); return entry; }));
    for (const entry of entries) { if (entry !== null) { table.set(entry.pid, entry); } }
  }
  return { table, skipped };
}

/** One actual read, distinct from the callers waiting to join a new batch. */
export async function observeProcessTableOnce(source: ProcessTableSource): Promise<ProcessTableObservation> {
  const started = performance.now();
  try {
    let result: ProcessTableRead = { table: new Map(), skipped: 0 };
    if (source === "procfs") { result = await readProcfs(); }
    else if (source === "ps") {
      result = parseProcessPs(await processTableCommand("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { ...process.env, LC_ALL: "C" }));
    } else {
      result = parseProcessWindows(await processTableCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}} | ConvertTo-Json -Compress"]));
    }
    if (!result.table.has(process.pid)) { throw new InvalidProcessTableError("missing_host"); }
    return { ok: true, source, elapsedMs: performance.now() - started, ...result };
  } catch (error) { return processTableFailure(error, source, performance.now() - started); }
}

type Reader = (source: ProcessTableSource) => Promise<ProcessTableObservation>;
interface WaitingBatch {
  started: boolean;
  readonly result: Promise<ProcessTableObservation>;
}

/** Only requests made before a read starts may use it. No result is cached. */
export function batchProcessTableReads(read: Reader): Reader {
  const batches = new Map<ProcessTableSource, WaitingBatch>();
  return async (source) => {
    const previous = batches.get(source);
    if (previous !== undefined && !previous.started) { return previous.result; }
    const observe = async (): Promise<ProcessTableObservation> => {
      // A pending generation waits for its predecessor, then admits every
      // caller that arrived before this query actually begins.
      if (previous !== undefined) { await previous.result; }
      await Promise.resolve();
      batch.started = true;
      const started = performance.now();
      try { return await read(source); }
      catch (error) { return processTableFailure(error, source, performance.now() - started); }
      finally { if (batches.get(source) === batch) { batches.delete(source); } }
    };
    // The observed promise is the same one callers await, with every read
    // failure converted into metadata. There is no detached worker promise.
    const batch: WaitingBatch = { started: false, result: observe() };
    batches.set(source, batch);
    const result = await batch.result;
    return result;
  };
}

const observeBatched = batchProcessTableReads(observeProcessTableOnce);
export async function observeProcessTableAsync(source: ProcessTableSource = processTableSource()): Promise<ProcessTableObservation> {
  const result = await observeBatched(source);
  return result;
}
