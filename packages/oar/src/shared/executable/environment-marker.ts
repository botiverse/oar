import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";

/*
 * An environment marker: a variable a child is started with, which every
 * process it starts inherits unless that process clears its environment.
 * After the child is gone, the processes still carrying it are the ones it
 * started, even those reparented away from it (a shell's `cmd &` or `nohup`
 * job, once the shell exited) and outside its process group, which a
 * parent-pid walk or a group kill cannot find. This is the approach of
 * Jenkins' ProcessTreeKiller. Linux only: it reads `/proc/<pid>/environ`,
 * which holds a process's environment as it was started; elsewhere there is
 * no portable way to read another process's environment, and nothing is
 * scanned.
 */

/** A fresh marker: `NAME=1`, the name unique to one child and starting with `prefix`. Not a secret. */
export function newEnvironmentMarker(prefix = "OAR_CURSOR_CHILD"): { readonly name: string; readonly entry: string } {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  return { name, entry: `${name}=1` };
}

/** The pids of this user's processes, other than this one, started with `entry` (`NAME=value`) in their environment. Linux only; empty elsewhere. */
export function markedProcesses(entry: string): number[] {
  if (process.platform !== "linux") { return []; }
  const uid = process.getuid?.();
  const found: number[] = [];
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return found; }
  for (const name of names) {
    const pid = Number(name);
    if (!/^\d+$/u.test(name) || pid === process.pid) { continue; }
    try {
      if (statSync(`/proc/${name}`).uid !== uid) { continue; }
      if (readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(entry)) { found.push(pid); }
    } catch {
      // Gone meanwhile, or not readable: not ours to end.
    }
  }
  return found;
}

const live = new Set<string>();
let exitHookInstalled = false;

/** Scan passes at most: a marked process may fork between a pass's read and its kill, so a pass that found some is followed by another. */
const PASSES = 5;

function kill(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Gone meanwhile. */ }
  }
}

/** SIGKILL every process `markedProcesses(entry)` finds, pass after pass until one finds none (at most five). Synchronous, so an `exit` hook can call it. */
export function killMarked(entry: string): void {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const found = markedProcesses(entry);
    if (found.length === 0) { return; }
    kill(found);
  }
}

/** The same without blocking the event loop: `/proc` is read asynchronously. */
export async function markedProcessesAsync(entry: string): Promise<number[]> {
  if (process.platform !== "linux") { return []; }
  const uid = process.getuid?.();
  let names: string[] = [];
  try { names = await readdir("/proc"); } catch { return []; }
  const checked = await Promise.all(names.map(async (name): Promise<number | null> => {
    const pid = Number(name);
    if (!/^\d+$/u.test(name) || pid === process.pid) { return null; }
    try {
      const owner = await stat(`/proc/${name}`);
      if (owner.uid !== uid) { return null; }
      const environment = await readFile(`/proc/${name}/environ`, "latin1");
      return environment.split("\0").includes(entry) ? pid : null;
    } catch {
      return null;
    }
  }));
  return checked.filter((pid): pid is number => pid !== null);
}

/** `killMarked` without blocking the event loop. */
export async function killMarkedAsync(entry: string): Promise<void> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each pass reads the table after the previous pass's kills.
    const found = await markedProcessesAsync(entry);
    if (found.length === 0) { return; }
    kill(found);
  }
}

/**
 * Keep `entry` scanned for while its child may run: a host that calls
 * `process.exit` ends the marked processes from its `exit` hook too.
 * Returns the release, for once the child exited and its marked processes
 * were ended.
 */
export function trackEnvironmentMarker(entry: string): () => void {
  live.add(entry);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const marker of live) { killMarked(marker); }
    });
  }
  return () => { live.delete(entry); };
}
