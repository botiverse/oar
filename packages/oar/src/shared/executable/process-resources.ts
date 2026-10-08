import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import type { SessionResources } from "../../contracts/session.js";
import { descendantsOf, type ProcessEntry } from "./process-tree.js";
import { runExecutable } from "./run.js";

/*
 * `Session.resources()`: the resident memory of a runtime process, its
 * process group and its descendants, read from one snapshot of the system
 * process table (docs/spec/record-stream.md#the-rules). Linux reads
 * `/proc/<pid>/stat` (ppid, pgrp, resident pages) and the page size; other
 * POSIX systems run `ps -A -o pid=,ppid=,pgid=,rss=` (rss in KiB). Windows has
 * no reader yet. Observation only: nothing is signalled, and no pid leaves oar.
 * A table that cannot be read whole gives no reading at all, never a count
 * that silently misses processes. Concurrent callers (a host asking every
 * session at once) share the one read in flight; nothing is kept after it.
 */

/** One process with its resident set, in bytes. */
interface Resident extends ProcessEntry {
  readonly rss: number;
}

const DEFAULT_PAGE_SIZE = 4096;
let pageSize: number | null = null;

/** The kernel's page size (`getconf PAGESIZE`), read once; 4096 when it cannot be read. */
async function linuxPageSize(): Promise<number> {
  if (pageSize === null) {
    const result = await runExecutable("getconf", ["PAGESIZE"], { timeoutMs: 5000 });
    const size = Number(result.stdout.trim());
    pageSize = result.ok && Number.isInteger(size) && size > 0 ? size : DEFAULT_PAGE_SIZE;
  }
  return pageSize;
}

/** The process went away between the listing and the read: skipped. Any other failure fails the reading. */
function gone(error: unknown): null {
  if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) {
    return null;
  }
  throw error;
}

/** `/proc/<pid>/stat`'s ppid, pgrp and rss (field 24, in pages); null once the process is gone. */
async function readStat(pid: number, page: number): Promise<Resident | null> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(gone);
  if (stat === null) {
    return null;
  }
  // The command name (field 2) is parenthesized and may hold spaces; fields resume after its last ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const [ppid, pgid, pages] = [Number(fields[1]), Number(fields[2]), Number(fields[21])];
  return Number.isInteger(ppid) && Number.isInteger(pgid) && Number.isInteger(pages)
    ? { pid, ppid, pgid, start: "", rss: pages * page }
    : null;
}

/** How many `stat` files are open at once: well under a low `ulimit -n` (1024). */
const BATCH = 64;

async function readProcfs(): Promise<ReadonlyMap<number, Resident>> {
  const page = await linuxPageSize();
  const listed = await readdir("/proc");
  const pids = listed.filter((name) => /^\d+$/u.test(name)).map(Number);
  const table = new Map<number, Resident>();
  for (let start = 0; start < pids.length; start += BATCH) {
    const batch = await Promise.all(pids.slice(start, start + BATCH).map(async (pid) => {
      const entry = await readStat(pid, page);
      return entry;
    }));
    for (const entry of batch) {
      if (entry !== null) { table.set(entry.pid, entry); }
    }
  }
  return table;
}

async function readPs(): Promise<ReadonlyMap<number, Resident> | null> {
  const result = await runExecutable("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss="], { env: { ...process.env, LC_ALL: "C" }, timeoutMs: 5000 });
  if (!result.ok) {
    return null;
  }
  const table = new Map<number, Resident>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match !== null) {
      const pid = Number(match[1]);
      table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: "", rss: Number(match[4]) * 1024 });
    }
  }
  return table;
}

/** The processes counted for `pid`: itself, the group it leads, and its descendants (those that left the group too). */
function counted(table: ReadonlyMap<number, Resident>, root: Resident): ReadonlyMap<number, Resident> {
  const members = new Map<number, Resident>([[root.pid, root]]);
  for (const entry of table.values()) {
    if (entry.pgid === root.pid) { members.set(entry.pid, entry); }
  }
  for (const { pid } of descendantsOf(table, root.pid)) {
    const resident = table.get(pid);
    if (resident !== undefined) { members.set(pid, resident); }
  }
  return members;
}

/** The table read each source has in flight. */
const inFlight = new Map<"procfs" | "ps", Promise<ReadonlyMap<number, Resident> | null>>();

/** One read of the table, forgotten once it settles; null when it cannot be read whole. */
async function readTable(source: "procfs" | "ps"): Promise<ReadonlyMap<number, Resident> | null> {
  try {
    const table = await (source === "procfs" ? readProcfs() : readPs());
    return table;
  } catch {
    return null;
  } finally {
    inFlight.delete(source);
  }
}

/** The process table now: the read already in flight, if one is, else a fresh one. */
async function currentTable(source: "procfs" | "ps"): Promise<ReadonlyMap<number, Resident> | null> {
  let read = inFlight.get(source);
  if (read === undefined) {
    read = readTable(source);
    inFlight.set(source, read);
  }
  const table = await read;
  return table;
}

/**
 * The resident memory of `pid`, the process group it leads and its
 * descendants, and how many processes that is. Null when `pid` is no longer
 * in the table, when the table cannot be read, and on Windows.
 */
export async function processTreeResources(pid: number, platform: NodeJS.Platform = process.platform): Promise<SessionResources | null> {
  if (platform === "win32") {
    return null;
  }
  const table = await currentTable(platform === "linux" ? "procfs" : "ps");
  const root = table?.get(pid);
  if (table === null || root === undefined) {
    return null;
  }
  const members = counted(table, root);
  let rss = 0;
  for (const member of members.values()) { rss += member.rss; }
  return { rss, processes: members.size };
}

/** A line process's `resources()`: null once `exited()` says it has, or before it has a pid. */
export function treeResourcesReader(child: ChildProcess, exited: () => boolean): () => Promise<SessionResources | null> {
  return async () => {
    const reading = exited() || child.pid === undefined ? null : await processTreeResources(child.pid);
    return reading;
  };
}
