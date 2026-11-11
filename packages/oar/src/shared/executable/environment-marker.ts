import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";

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

/** A fresh marker: `NAME=1`, the name unique to one child. Not a secret. */
export function newEnvironmentMarker(): { readonly name: string; readonly entry: string } {
  const name = `OAR_CURSOR_CHILD_${randomUUID().replaceAll("-", "")}`;
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

/** SIGKILL every process `markedProcesses(entry)` finds. Synchronous, so an `exit` hook can call it. */
export function killMarked(entry: string): void {
  for (const pid of markedProcesses(entry)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Gone meanwhile. */ }
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
