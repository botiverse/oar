import { readdir, readFile } from "node:fs/promises";
import { asRecord } from "../json.js";
import { InvalidProcessTableError, parseProcessPs, parseProcessStat, parseProcessWindows, processTableFailure, type ProcessEntry, type ProcessTableObservation, type ProcessTableRead, type ProcessTableSource } from "./process-tree.js";
import { processTableCommand, type ProcessTableReadOptions } from "./process-table-command.js";
import { processTiming, processTimingId } from "./process-timing.js";

const BATCH = 64;
export const processTableSource = (): ProcessTableSource => process.platform === "linux" ? "procfs" : (process.platform === "win32" ? "windows" : "ps");

async function readProcfs(): Promise<ProcessTableRead> {
  const names = await readdir("/proc");
  const listed = names.filter((name) => /^\d+$/u.test(name));
  const table = new Map<number, ProcessEntry>();
  const unreadable = new Set<number>();
  const read = async (name: string): Promise<ProcessEntry | null> => {
    try { return parseProcessStat(Number(name), await readFile(`/proc/${name}/stat`, "utf8")); }
    catch (error) {
      const code = asRecord(error)?.code;
      if (code === "ENOENT" || code === "ESRCH") { return null; }
      if (code === "EACCES" || code === "EPERM") { unreadable.add(Number(name)); return null; }
      throw error;
    }
  };
  for (let offset = 0; offset < listed.length; offset += BATCH) {
    const entries = await Promise.all(listed.slice(offset, offset + BATCH).map(async (name) => { const entry = await read(name); return entry; }));
    for (const entry of entries) { if (entry !== null) { table.set(entry.pid, entry); } }
  }
  return { table, skipped: unreadable.size, unreadable };
}

/** One actual read, distinct from the callers waiting to join a new batch. */
export async function observeProcessTableOnce(source: ProcessTableSource, options?: ProcessTableReadOptions): Promise<ProcessTableObservation> {
  const started = performance.now();
  try {
    let result: ProcessTableRead = { table: new Map(), skipped: 0 };
    if (source === "procfs") { result = await readProcfs(); }
    else if (source === "ps") {
      result = parseProcessPs(await processTableCommand("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { ...process.env, LC_ALL: "C" }, options));
    } else {
      result = parseProcessWindows(await processTableCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}} | ConvertTo-Json -Compress"], undefined, options));
    }
    if (!result.table.has(process.pid)) { throw new InvalidProcessTableError("missing_host"); }
    return { ok: true, source, elapsedMs: performance.now() - started, ...result };
  } catch (error) { return processTableFailure(error, source, performance.now() - started); }
}

type Reader = (source: ProcessTableSource, options?: ProcessTableReadOptions) => Promise<ProcessTableObservation>;
export interface ProcessTableRequestOptions extends ProcessTableReadOptions {
  /**
   * Deadline on performance.now()'s clock, gating query start only.
   * observeProcessTableWithin rejects late results; direct callers passing
   * a deadline must check result timeliness themselves.
   */
  readonly deadline?: number;
}
type Request = (source: ProcessTableSource, options?: ProcessTableRequestOptions) => Promise<ProcessTableObservation>;
interface WaitingBatch {
  readonly queryId: number;
  started: boolean;
  readonly callers: ProcessTableRequestOptions[];
  readonly result: Promise<ProcessTableObservation>;
}

/** Only requests made before a read starts may use it. No result is cached. */
export function batchProcessTableReads(read: Reader): Request {
  const batches = new Map<ProcessTableSource, WaitingBatch>();
  return async (source, options) => {
    const previous = batches.get(source);
    if (previous !== undefined && !previous.started) {
      previous.callers.push({ ...options });
      if (options?.requestId !== undefined) { processTiming({ kind: "query_joined", queryId: previous.queryId, requestId: options.requestId }); }
      return previous.result;
    }
    const requested = performance.now();
    const queryId = processTimingId();
    processTiming({ kind: "query_queued", queryId, source, ...(previous === undefined ? {} : { behindQueryId: previous.queryId }) }, requested);
    if (options?.requestId !== undefined) { processTiming({ kind: "query_joined", queryId, requestId: options.requestId }, requested); }
    const observe = async (): Promise<ProcessTableObservation> => {
      // A pending generation waits for its predecessor, then admits every
      // caller that arrived before this query actually begins.
      if (previous !== undefined) { await previous.result; }
      await Promise.resolve();
      let started = requested;
      try {
        batch.started = true;
        started = performance.now();
        const live = batch.callers.filter(caller => caller.deadline === undefined || started < caller.deadline);
        for (const caller of batch.callers) {
          if (caller.deadline !== undefined && started >= caller.deadline && caller.requestId !== undefined) {
            processTiming({ kind: "query_caller_expired", queryId, requestId: caller.requestId }, started);
          }
        }
        batch.callers.length = 0;
        // Expired callers cannot start a query or keep a background read alive.
        // A query already started still runs to completion under its own limit.
        if (live.length === 0) {
          processTiming({ kind: "query_skipped", queryId }, started);
          return { ok: false, source, reason: "timeout", elapsedMs: started - requested };
        }
        const background = live.every(caller => caller.background === true);
        processTiming({ kind: "query_started", queryId });
        const result = await read(source, background ? { background: true } : undefined);
        processTiming({ kind: "query_finished", queryId, outcome: result.ok ? "ok" : "failed" });
        return result;
      }
      catch (error) {
        processTiming({ kind: "query_finished", queryId, outcome: "failed" });
        return processTableFailure(error, source, performance.now() - started);
      }
      finally { if (batches.get(source) === batch) { batches.delete(source); } }
    };
    // The observed promise is the same one callers await, with every read
    // failure converted into metadata. There is no detached worker promise.
    const batch: WaitingBatch = { queryId, started: false, callers: [{ ...options }], result: observe() };
    batches.set(source, batch);
    const result = await batch.result;
    return result;
  };
}

const observeBatched = batchProcessTableReads(observeProcessTableOnce);
export async function observeProcessTableAsync(source: ProcessTableSource = processTableSource(), options?: ProcessTableRequestOptions): Promise<ProcessTableObservation> {
  const result = await observeBatched(source, options);
  return result;
}
