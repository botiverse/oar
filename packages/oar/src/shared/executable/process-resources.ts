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

/** `/proc/<pid>/stat`'s ppid, pgrp and rss (field 24, in pages); null once the process is gone. */
async function readStat(pid: number, page: number): Promise<Resident | null> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch((): null => null);
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

async function readProcfs(): Promise<ReadonlyMap<number, Resident>> {
  const page = await linuxPageSize();
  const listed = await readdir("/proc");
  const entries = await Promise.all(listed.filter((name) => /^\d+$/u.test(name)).map(async (name) => {
    const entry = await readStat(Number(name), page);
    return entry;
  }));
  return new Map(entries.flatMap((entry) => (entry === null ? [] : [[entry.pid, entry] as const])));
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

/**
 * The resident memory of `pid`, the process group it leads and its
 * descendants, and how many processes that is. Null when `pid` is no longer
 * in the table, when the table cannot be read, and on Windows.
 */
export async function processTreeResources(pid: number, platform: NodeJS.Platform = process.platform): Promise<SessionResources | null> {
  if (platform === "win32") {
    return null;
  }
  const table = await (platform === "linux" ? readProcfs() : readPs()).catch((): null => null);
  const root = table?.get(pid);
  if (table === null || root === undefined) {
    return null;
  }
  const members = counted(table, root);
  let rss = 0;
  for (const member of members.values()) { rss += member.rss; }
  return { rss, processes: members.size };
}
