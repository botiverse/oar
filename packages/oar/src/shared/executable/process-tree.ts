import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { asRecord } from "../json.js";

/*
 * A runtime's descendants on POSIX, read from the system process table, so
 * that ending the runtime ends them too. Its process group alone does not
 * reach them all: a descendant can leave the group (claude 2.1.292 runs each
 * Bash tool command in a session of its own), and once the runtime is gone
 * such a process is re-parented to init or a subreaper, where the tree no
 * longer leads to it. So the table is read while the runtime still runs, and
 * read again before anything in it is signalled: a pid is signalled only if
 * the same process (same start time) still holds it.
 */

/** One process in the table. `start` tells it from a later process given the same pid. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
}

/** The process table at one moment, by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

interface ProcessTableRead {
  readonly table: ProcessTable;
  /** Entries omitted because access or a start identity was unavailable. */
  readonly skipped: number;
}

export type ProcessTableSource = "procfs" | "ps" | "windows";
export type ProcessTableFailureReason = "timeout" | "command_failed" | "spawn_failed" | "read_failed" | "invalid_output" | "missing_host" | "missing_root";
/** No command output, process names, arguments or environment values are retained. */
export interface ProcessTableFailure {
  readonly ok: false;
  readonly source: ProcessTableSource;
  readonly elapsedMs: number;
  readonly reason: ProcessTableFailureReason;
  readonly code?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timeoutMs?: number;
}
export type ProcessTableObservation = ProcessTableFailure | (ProcessTableRead & {
  readonly ok: true;
  readonly source: ProcessTableSource;
  readonly elapsedMs: number;
});

class InvalidProcessTableError extends Error {
  constructor(readonly reason: "invalid_output" | "missing_host" = "invalid_output") { super(reason); this.name = "InvalidProcessTableError"; }
}

/** `/proc/<pid>/stat`'s ppid, pgrp and starttime (clock ticks since boot); null once the process is gone. */
function readStat(pid: number): ProcessEntry | null {
  let stat = "";
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch (error) {
    // Processes can disappear during enumeration. The caller separately
    // counts permission-denied entries; other read errors fail the table.
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) { return null; }
    throw error;
  }
  // Field 2, the command name, is parenthesized and may itself hold spaces
  // and parentheses; the fields after its last ")" start at field 3 (state).
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const [ppid, pgid, start] = [Number(fields[1]), Number(fields[2]), fields[19]];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || start === undefined || !/^\d+$/u.test(start)) { throw new InvalidProcessTableError(); }
  return { pid, ppid, pgid, start };
}

/** Linux: every process's stat. */
function readProcfs(): ProcessTableRead {
  const table = new Map<number, ProcessEntry>();
  let skipped = 0;
  for (const name of readdirSync("/proc")) {
    try {
      const entry = /^\d+$/u.test(name) ? readStat(Number(name)) : null;
      if (entry !== null) { table.set(entry.pid, entry); }
    } catch (error) {
      // hidepid can deny other users' stat files without hiding our tree.
      // Never signal these entries, but keep the count visible to cleanup.
      const code = asRecord(error)?.code;
      if (code === "EACCES" || code === "EPERM") { skipped += 1; }
      else { throw error; }
    }
  }
  return { table, skipped };
}

/** Other POSIX systems (macOS): one `ps` run; `lstart` is the start time to the second. */
function readPs(): ProcessTableRead {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const table = new Map<number, ProcessEntry>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") { continue; }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/u.exec(line);
    if (match !== null) {
      const pid = Number(match[1]);
      table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? "" });
    } else { throw new InvalidProcessTableError(); }
  }
  return { table, skipped: 0 };
}

/** Windows has no process groups; creation time distinguishes reused PIDs. */
function readWindows(): ProcessTableRead {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}} | ConvertTo-Json -Compress"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 16 * 1024 * 1024,
  });
  const values: unknown = JSON.parse(output);
  const table = new Map<number, ProcessEntry>();
  let skipped = 0;
  for (const value of Array.isArray(values) ? values : [values]) {
    const entry = asRecord(value);
    if (entry === null || typeof entry.ProcessId !== "number" || !Number.isInteger(entry.ProcessId) || entry.ProcessId < 0
      || typeof entry.ParentProcessId !== "number" || !Number.isInteger(entry.ParentProcessId) || entry.ParentProcessId < 0) { throw new InvalidProcessTableError(); }
    // Non-admin hosts may not see protected processes' creation times.
    // Omit identities we cannot revalidate, without rejecting readable peers.
    if (entry.Started === undefined || entry.Started === null || entry.Started === "") { skipped += 1; continue; }
    if (typeof entry.Started !== "string") { throw new InvalidProcessTableError(); }
    if (entry.ProcessId === 0 || entry.ProcessId === 4) { skipped += 1; continue; }
    table.set(entry.ProcessId, { pid: entry.ProcessId, ppid: entry.ParentProcessId, pgid: 0, start: entry.Started });
  }
  return { table, skipped };
}

/**
 * The process table now (synchronous: the host's `exit` hook reads it too).
 * A failed observation is distinct from a valid table with no descendants.
 * The host must appear in a usable table, including its group on POSIX.
 */
export function observeProcessTable(source: ProcessTableSource = process.platform === "linux" ? "procfs" : (process.platform === "win32" ? "windows" : "ps")): ProcessTableObservation {
  const started = performance.now();
  try {
    const result = source === "procfs" ? readProcfs() : (source === "windows" ? readWindows() : readPs());
    if (!result.table.has(process.pid)) { throw new InvalidProcessTableError("missing_host"); }
    return { ok: true, source, elapsedMs: performance.now() - started, ...result };
  } catch (error) {
    const native = asRecord(error);
    // Node's execFileSync error can embed stdout and the whole command.
    // Preserve its identifying fields, never its message or output.
    const code = typeof native?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(native.code) ? native.code : undefined;
    const exitCode = typeof native?.status === "number" ? native.status : undefined;
    const signal = typeof native?.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(native.signal) ? native.signal : undefined;
    let reason: ProcessTableFailureReason = "read_failed";
    if (code === "ETIMEDOUT") { reason = "timeout"; }
    else if (error instanceof InvalidProcessTableError) { reason = error.reason; }
    else if (error instanceof SyntaxError) { reason = "invalid_output"; }
    else if (exitCode !== undefined) { reason = "command_failed"; }
    else if (code === "ENOENT" || code === "EACCES" && source !== "procfs") { reason = "spawn_failed"; }
    return {
      ok: false, source, elapsedMs: performance.now() - started, reason,
      ...(code === undefined ? {} : { code }), ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }), ...(reason === "timeout" ? { timeoutMs: 5000 } : {}),
    };
  }
}

/** Convenience for probes that require a usable observation. Never returns an empty fallback. */
export function readProcessTable(source?: ProcessTableSource): ProcessTable {
  const result = observeProcessTable(source);
  if (result.ok) { return result.table; }
  throw new Error(`Process table ${result.source}: ${result.reason}${result.code === undefined ? "" : ` (${result.code})`} after ${result.elapsedMs.toFixed(0)} ms`, { cause: result });
}

/** Every process below `pid` in `table`: its children, theirs, and so on. */
export function descendantsOf(table: ProcessTable, pid: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table.values()) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) {
      children.set(entry.ppid, [entry]);
    } else {
      siblings.push(entry);
    }
  }
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([pid]);
  const pending = [pid];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        found.push(child);
        pending.push(child.pid);
      }
    }
  }
  return found;
}

/**
 * SIGKILL each of `entries` that `table` (read just before) shows still
 * running, the same process (same start time), and the process group each
 * belongs to now: the runtime's own, or one a descendant made, which can hold
 * processes started since the entries were read. Never the host, nor its group.
 */
export function killEntries(entries: Iterable<ProcessEntry>, table: ProcessTable): void {
  const hostGroup = table.get(process.pid)?.pgid;
  if (hostGroup === undefined) { return; }
  const groups = new Set<number>();
  const pids = new Set<number>();
  for (const entry of entries) {
    const current = table.get(entry.pid);
    if (current === undefined || current.start !== entry.start || current.pid === process.pid) {
      continue;
    }
    pids.add(current.pid);
    if (current.pgid > 1 && current.pgid !== hostGroup) {
      groups.add(current.pgid);
    }
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // The group emptied meanwhile.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone meanwhile.
    }
  }
}
