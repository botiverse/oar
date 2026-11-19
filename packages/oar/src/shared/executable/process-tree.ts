import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { asRecord } from "../json.js";

/* Capture descendants before root exit: detached tools can leave the group
 * and be reparented. Revalidate PID and start time before signalling them. */

/** One process in the table. `start` tells it from a later process given the same pid. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
  /** POSIX has recorded exit but the parent has not reaped the process yet. */
  readonly zombie?: true;
}

/** The process table at one moment, by pid. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

export interface ProcessTableRead {
  readonly table: ProcessTable;
  /** Entries omitted because access or a start identity was unavailable. */
  readonly skipped: number;
  /** Enumerated PIDs whose identities could not be read. Never exposed in diagnostics. */
  readonly unreadable?: ReadonlySet<number>;
}

export type ProcessTableSource = "procfs" | "ps" | "windows";
export type ProcessTableFailureReason = "timeout" | "command_failed" | "spawn_failed" | "read_failed" | "invalid_output" | "missing_host" | "missing_root" | "descendant_unreadable" | "descendant_still_running" | "descendant_exit_unconfirmed";
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

export class InvalidProcessTableError extends Error {
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
  return parseProcessStat(pid, stat);
}

export function parseProcessStat(pid: number, stat: string): ProcessEntry {
  // Field 2, the command name, is parenthesized and may itself hold spaces
  // and parentheses; the fields after its last ")" start at field 3 (state).
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const [ppid, pgid, start] = [Number(fields[1]), Number(fields[2]), fields[19]];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || start === undefined || !/^\d+$/u.test(start)) { throw new InvalidProcessTableError(); }
  return { pid, ppid, pgid, start, ...(fields[0] === "Z" ? { zombie: true } : {}) };
}

/** Linux: every process's stat. */
function readProcfs(): ProcessTableRead {
  const table = new Map<number, ProcessEntry>();
  const unreadable = new Set<number>();
  for (const name of readdirSync("/proc")) {
    try {
      const entry = /^\d+$/u.test(name) ? readStat(Number(name)) : null;
      if (entry !== null) { table.set(entry.pid, entry); }
    } catch (error) {
      // hidepid can deny other users' stat files without hiding our tree.
      // Never signal these entries, but keep the count visible to cleanup.
      const code = asRecord(error)?.code;
      if (code === "EACCES" || code === "EPERM") { unreadable.add(Number(name)); }
      else { throw error; }
    }
  }
  return { table, skipped: unreadable.size, unreadable };
}

/** Other POSIX systems (macOS): one `ps` run; `lstart` is the start time to the second. */
function readPs(): ProcessTableRead {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseProcessPs(output);
}

export function parseProcessPs(output: string): ProcessTableRead {
  const table = new Map<number, ProcessEntry>();
  for (const line of output.split("\n")) {
    if (line.trim() === "") { continue; }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/u.exec(line);
    if (match !== null) {
      const pid = Number(match[1]);
      table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: match[5] ?? "", ...(match[4]?.startsWith("Z") === true ? { zombie: true } : {}) });
    } else { throw new InvalidProcessTableError(); }
  }
  return { table, skipped: 0 };
}

/** Windows has no process groups; creation time distinguishes reused PIDs. */
function readWindows(): ProcessTableRead {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}} | ConvertTo-Json -Compress"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  return parseProcessWindows(output);
}

export function parseProcessWindows(output: string): ProcessTableRead {
  const values: unknown = JSON.parse(output);
  const table = new Map<number, ProcessEntry>();
  const unreadable = new Set<number>();
  for (const value of Array.isArray(values) ? values : [values]) {
    const entry = asRecord(value);
    if (entry === null || typeof entry.ProcessId !== "number" || !Number.isInteger(entry.ProcessId) || entry.ProcessId < 0
      || typeof entry.ParentProcessId !== "number" || !Number.isInteger(entry.ParentProcessId) || entry.ParentProcessId < 0) { throw new InvalidProcessTableError(); }
    // Non-admin hosts may not see protected processes' creation times.
    // Omit identities we cannot revalidate, without rejecting readable peers.
    if (entry.Started === undefined || entry.Started === null || entry.Started === "") { unreadable.add(entry.ProcessId); continue; }
    if (typeof entry.Started !== "string") { throw new InvalidProcessTableError(); }
    if (entry.ProcessId === 0 || entry.ProcessId === 4) { unreadable.add(entry.ProcessId); continue; }
    table.set(entry.ProcessId, { pid: entry.ProcessId, ppid: entry.ParentProcessId, pgid: 0, start: entry.Started });
  }
  return { table, skipped: unreadable.size, unreadable };
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
    return processTableFailure(error, source, performance.now() - started);
  }
}

/** Only bounded metadata leaves a failed process-table observation. */
export function processTableFailure(error: unknown, source: ProcessTableSource, elapsedMs: number): ProcessTableFailure {
  const native = asRecord(error);
  // Node's execFileSync error can embed stdout and the whole command.
  // Preserve its identifying fields, never its message or output.
  const code = typeof native?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(native.code) ? native.code : undefined;
  const exitCode = typeof native?.status === "number" ? native.status : (typeof native?.code === "number" ? native.code : undefined);
  const signal = typeof native?.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(native.signal) ? native.signal : undefined;
  let reason: ProcessTableFailureReason = "read_failed";
  if (code === "ETIMEDOUT") { reason = "timeout"; }
  else if (error instanceof InvalidProcessTableError) { reason = error.reason; }
  else if (error instanceof SyntaxError) { reason = "invalid_output"; }
  else if (exitCode !== undefined) { reason = "command_failed"; }
  else if (code === "ENOENT" || code === "EACCES" && source !== "procfs") { reason = "spawn_failed"; }
  return {
    ok: false, source, elapsedMs, reason,
    ...(code === undefined ? {} : { code }), ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }), ...(reason === "timeout" ? { timeoutMs: 5000 } : {}),
  };
}

/** Convenience for probes that require a usable observation. Never returns an empty fallback. */
export function readProcessTable(source?: ProcessTableSource): ProcessTable {
  const result = observeProcessTable(source);
  if (result.ok) { return result.table; }
  throw new Error(`Process table ${result.source}: ${result.reason}${result.code === undefined ? "" : ` (${result.code})`} after ${result.elapsedMs.toFixed(0)} ms`, { cause: result });
}

/**
 * Every process below `pid`. Windows preserves a dead parent's PID, so an
 * edge is usable only if the child was created no earlier than this parent.
 */
export function descendantsOf(table: ProcessTable, pid: number, source: ProcessTableSource = process.platform === "win32" ? "windows" : "procfs"): ProcessEntry[] {
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
      const parentEntry = table.get(parent);
      const validParent = source !== "windows" || parentEntry !== undefined && child.start >= parentEntry.start;
      if (!seen.has(child.pid) && validParent) {
        seen.add(child.pid);
        found.push(child);
        pending.push(child.pid);
      }
    }
  }
  return found;
}

/** What one round of signals did. `failed` counts processes a signal could not reach while they ran; a process already gone is neither, nor is one in `foreign`. */
export interface SignalReport {
  /** False when `table` does not show the host: nothing is signalled without its group to protect. */
  readonly hostIdentified: boolean;
  readonly signalled: number;
  readonly failed: number;
  /** Processes OAR may not signal (EPERM), another user's (a `sudo -u` wrapper's tree): not OAR's to stop, so not a failed cleanup. */
  readonly foreign: number;
  /** Bounded native error codes behind `failed`. */
  readonly codes: readonly string[];
}

function signalCode(error: unknown): string {
  const code = asRecord(error)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "UNKNOWN";
}

/**
 * Signal each of `entries` that `table` (read just before) shows still
 * running, the same process (same start time), and the process group each
 * belongs to now: the runtime's own, or one a descendant made, which can hold
 * processes started since the entries were read. Never the host, nor its group,
 * nor a group `mayKillGroup` holds back. Says what was actually sent.
 */
export function signalEntries(entries: Iterable<ProcessEntry>, table: ProcessTable, mayKillGroup: (group: number) => boolean = () => true, signal: NodeJS.Signals = "SIGKILL", denied?: Set<number>): SignalReport {
  const hostGroup = table.get(process.pid)?.pgid;
  if (hostGroup === undefined) { return { hostIdentified: false, signalled: 0, failed: 0, foreign: 0, codes: [] }; }
  const groups = new Set<number>();
  const pids = new Map<number, number>();
  for (const entry of entries) {
    const current = table.get(entry.pid);
    if (current === undefined || current.start !== entry.start || current.pid === process.pid) {
      continue;
    }
    pids.set(current.pid, current.pgid);
    if (current.pgid > 1 && current.pgid !== hostGroup && mayKillGroup(current.pgid)) {
      groups.add(current.pgid);
    }
  }
  const reached = new Set<number>();
  for (const group of groups) {
    try {
      process.kill(-group, signal);
      reached.add(group);
    } catch {
      // The group emptied meanwhile, or none of it is OAR's (EPERM): each member's own signal settles it.
    }
  }
  let signalled = 0;
  let failed = 0;
  let foreign = 0;
  const codes = new Set<string>();
  for (const [pid, group] of pids) {
    try {
      process.kill(pid, signal);
      signalled += 1;
    } catch (error) {
      const code = signalCode(error);
      // A successful group signal does not establish permission for every
      // member. Whole-tree exit confirmation needs the direct PID result.
      if (code === "EPERM") { denied?.add(pid); }
      // Its group's signal may already have reaped it.
      if (reached.has(group)) { signalled += 1; }
      else if (code === "EPERM") { foreign += 1; }
      else if (code !== "ESRCH") { failed += 1; codes.add(code); }
    }
  }
  return { hostIdentified: true, signalled, failed, foreign, codes: [...codes] };
}

/** Return PIDs for which the OS directly refused permission to signal this identity. */
export function killEntries(entries: Iterable<ProcessEntry>, table: ProcessTable): ReadonlySet<number> {
  const denied = new Set<number>();
  signalEntries(entries, table, undefined, "SIGKILL", denied);
  return denied;
}
