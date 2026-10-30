import { execFile, type ChildProcess } from "node:child_process";
import { trackOwnedProcess } from "./ownership.js";

/**
 * How long a process asked to stop (SIGTERM) gets before it is killed outright
 * (SIGKILL): the bound that keeps `kill()` followed by `await exited` from
 * hanging on a process that ignores the request. Generous on purpose: claude
 * answers SIGTERM with a shutdown of its own that runs its SessionEnd hooks
 * and force-exits after max(5 s, hook budget + 5 s), 15 s while writes are
 * still pending (2.1.283; the hook budget defaults to 1.5 s), and cutting that
 * short kills the hooks with it. Observed exits take 0.6-2.3 s.
 */
export const KILL_GRACE_MS = 10_000;
/**
 * The grace period in force: `OAR_KILL_GRACE_MS` when it holds a nonnegative
 * number of milliseconds (a host whose runtimes need longer, e.g. claude with
 * slow SessionEnd hooks, or that wants a faster teardown), else `KILL_GRACE_MS`.
 */
export function killGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.OAR_KILL_GRACE_MS?.trim() ?? "";
  const value = Number(configured);
  return configured.length > 0 && Number.isFinite(value) && value >= 0 ? value : KILL_GRACE_MS;
}
/**
 * POSIX children are spawned detached, which makes each the leader of its own
 * process group, so one signal to the negative pid reaches every process it
 * started (shells, dev servers, MCP servers), not only the child itself.
 * Detaching changes neither stdio nor exit tracking: the pipes stay connected
 * and the child is never unref'd, so the host still observes its exit. It does
 * take the child out of the terminal's job control: Ctrl-C (SIGINT) and SIGHUP
 * reach the host only, so a host that wants them to stop its runtimes
 * disposes its sessions on them. Windows has no process groups, and a
 * detached child there gets its own console, so it stays attached.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";
/**
 * Send `signal` to a child spawned with `detached: OWN_PROCESS_GROUP` and to
 * everything in its process group. Falls back to the child alone where there
 * are no groups (Windows) or the group is gone (the child left it; ESRCH).
 * A reaped child's pid can be reused, so call this only while the child, or a
 * process it started, can still be alive.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (OWN_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Nobody is left in the group; the child itself may still be alive in
      // a group of its own making, so it is signalled directly below.
    }
  }
  child.kill(signal);
}
/**
 * Windows taskkill /T /F ends the child and its descendants, falling back to
 * the child alone when the walk fails. An exited child's pid may already be reused.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
    if (error !== null) {
      child.kill();
    }
  });
  trackOwnedProcess(killer);
}
