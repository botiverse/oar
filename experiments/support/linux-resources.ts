/** Linux-only observation for experiments. Never reads argv, environment or descriptor targets. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/* oxlint-disable eslint/no-await-in-loop -- Serial procfs reads bound descriptor use and do not add measurement worker processes. */
export interface LinuxProcess {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly started: number;
  readonly state: string;
  readonly rssBytes: number;
  readonly cpuTicks: number;
}
const pageBytes = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim());
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
assert.ok(pageBytes > 0 && ticksPerSecond > 0);

function gone(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}
export async function processTable(): Promise<ReadonlyMap<number, LinuxProcess>> {
  assert.equal(process.platform, "linux", "this measurement requires Linux procfs");
  const table = new Map<number, LinuxProcess>();
  const listed = await readdir("/proc");
  for (const name of listed.filter((candidate) => /^\d+$/u.test(candidate))) {
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const entry = { pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
        started: Number(fields[19]), state: fields[0] ?? "", rssBytes: Number(fields[21]) * pageBytes,
        cpuTicks: Number(fields[11]) + Number(fields[12]) };
      assert.ok(Object.values(entry).every((value) => typeof value !== "number" || Number.isFinite(value)));
      table.set(entry.pid, entry);
    } catch (error) { if (!gone(error)) { throw error; } }
  }
  return table;
}

/** Detached process groups and descendants, including children which changed group. */
export function forest(table: ReadonlyMap<number, LinuxProcess>, roots: readonly LinuxProcess[]): LinuxProcess[] {
  const members = new Map<number, LinuxProcess>();
  for (const root of roots.filter((entry) => table.get(entry.pid)?.started === entry.started)) {
    for (const entry of table.values()) {
      if (entry.pid === root.pid || entry.group === root.pid) { members.set(entry.pid, entry); }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of table.values()) {
      if (!members.has(entry.pid) && members.has(entry.parent)) { members.set(entry.pid, entry); changed = true; }
    }
  }
  return [...members.values()];
}
export async function newRoots(before: ReadonlyMap<number, LinuxProcess>): Promise<LinuxProcess[]> {
  const table = await processTable();
  return [...table.values()].filter((entry) => entry.parent === process.pid && !before.has(entry.pid));
}

export async function reading(roots: readonly LinuxProcess[]): Promise<{
  readonly at: number; readonly processes: readonly LinuxProcess[]; readonly rssBytes: number; readonly fds: number | null;
  readonly fdsObserved: number; readonly fdReadFailures: readonly { pid: number; code: string }[];
}> {
  const processes = forest(await processTable(), roots);
  let fds = 0;
  const fdReadFailures: { pid: number; code: string }[] = [];
  for (const entry of processes) {
    try { const descriptors = await readdir(`/proc/${String(entry.pid)}/fd`); fds += descriptors.length; }
    catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
        fdReadFailures.push({ pid: entry.pid, code: error.code });
      } else if (!gone(error)) { throw error; }
    }
  }
  return { at: performance.now(), processes, rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
    fds: fdReadFailures.length === 0 ? fds : null, fdsObserved: fds, fdReadFailures };
}

/** CPU percentage is relative to one core. Exited processes make the delta a lower bound. */
export async function sample(roots: readonly LinuxProcess[], windowMs = 5000): Promise<Record<string, unknown>> {
  const first = await reading(roots);
  await delay(windowMs);
  const last = await reading(roots);
  const before = new Map(first.processes.map((entry) => [entry.pid, entry]));
  const elapsedMs = last.at - first.at;
  let ticks = 0;
  for (const entry of last.processes) {
    const previous = before.get(entry.pid);
    ticks += entry.cpuTicks - (previous?.started === entry.started ? previous.cpuTicks : 0);
  }
  const exited = first.processes.filter((entry) => !last.processes.some((candidate) => candidate.pid === entry.pid && candidate.started === entry.started));
  return { elapsedMs, cpuPercentOneCore: ticks / ticksPerSecond / (elapsedMs / 1000) * 100,
    cpuTicks: ticks, cpuIsLowerBound: exited.length > 0, exitedDuringWindow: exited.length,
    rssBytesBefore: first.rssBytes, rssBytes: last.rssBytes, fds: last.fds,
    fdsObserved: last.fdsObserved, fdReadFailures: last.fdReadFailures,
    processes: last.processes.length, members: last.processes };
}

export async function survivors(observed: readonly LinuxProcess[]): Promise<LinuxProcess[]> {
  const table = await processTable();
  return observed.filter((entry) => table.get(entry.pid)?.started === entry.started).map((entry) => table.get(entry.pid) ?? entry);
}

/** Only child environments change. The experiment never imports the host's account credentials. */
export function isolatedEnvironment(home: string): Record<string, string | null> {
  const env: Record<string, string | null> = Object.fromEntries(Object.keys(process.env).map((name) => [name, null]));
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[name] !== undefined) { env[name] = process.env[name] ?? null; }
  }
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: `${home}/config`,
    XDG_DATA_HOME: `${home}/data`, XDG_STATE_HOME: `${home}/state`, XDG_CACHE_HOME: `${home}/cache`, NO_PROXY: "*" };
}
