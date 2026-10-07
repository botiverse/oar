import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

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

/** `/proc/<pid>/stat`'s ppid, pgrp and starttime (clock ticks since boot); null once the process is gone. */
function readStat(pid: number): ProcessEntry | null {
  let stat = "";
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return null;
  }
  // Field 2, the command name, is parenthesized and may itself hold spaces
  // and parentheses; the fields after its last ")" start at field 3 (state).
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const [ppid, pgid, start] = [Number(fields[1]), Number(fields[2]), fields[19]];
  return Number.isInteger(ppid) && Number.isInteger(pgid) && start !== undefined ? { pid, ppid, pgid, start } : null;
}

/** Linux: every process's stat. */
function readProcfs(): ProcessTable {
  const table = new Map<number, ProcessEntry>();
  for (const name of readdirSync("/proc")) {
    const entry = /^\d+$/u.test(name) ? readStat(Number(name)) : null;
    if (entry !== null) {
      table.set(entry.pid, entry);
    }
  }
  return table;
}

/** Other POSIX systems (macOS): one `ps` run; `lstart` is the start time to the second. */
function readPs(): ProcessTable {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const table = new Map<number, ProcessEntry>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/u.exec(line);
    if (match !== null) {
      const pid = Number(match[1]);
      table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? "" });
    }
  }
  return table;
}

/**
 * The process table now (synchronous: the host's `exit` hook reads it too).
 * Empty when it cannot be read; the caller then reaches the process group only.
 */
export function readProcessTable(source: "procfs" | "ps" = process.platform === "linux" ? "procfs" : "ps"): ProcessTable {
  try {
    return source === "procfs" ? readProcfs() : readPs();
  } catch {
    return new Map();
  }
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
