import { nodeEvalExecutable } from "./node-eval.js";
import { killGraceMs } from "./process-signals.js";

/*
 * A long-lived child that must not outlive the host even when the host is
 * SIGKILLed: Node runs no `exit` hook then (ownership.ts), so nothing in the
 * host can stop it. The command runs under a tiny Node watchdog (the host's
 * own `process.execPath`) whose stdin is a pipe from the host. Every way the
 * host can end closes that pipe, so the watchdog's stdin reaching EOF means
 * "the host is gone or wants the command stopped". The watchdog then stops
 * the command and everything it started: SIGTERM to the command's own
 * process group, SIGKILL to it after the grace period or as soon as the
 * command exits (POSIX); `taskkill /T /F` on its tree (Windows, which has no
 * groups). On Windows the host starts the watchdog detached: Node puts a
 * child it does not detach in a job object that ends it together with a
 * dying host, and a grandchild the command starts (a `.cmd` shim's node) is
 * outside that job, so it would outlive both. A watchdog that is itself
 * killed outright leaves the same gap. A SIGTERM, SIGINT or SIGHUP to the
 * watchdog does the same as EOF. The
 * command's stdout and stderr are the watchdog's, so the host reads them
 * unchanged; its stdin is not connected. The watchdog exits with the
 * command's exit code (1 when a signal ended it). In an Electron host,
 * `process.execPath` is Electron, which runs `-e` only as Node with
 * `ELECTRON_RUN_AS_NODE=1`: the watchdog gets it, and the command gets the
 * environment's own value back. A compiled single executable host (Node
 * SEA, Bun standalone) cannot run the watchdog: its `process.execPath`
 * would start the application again. There the command runs without one,
 * so it stops with the host's own exit cleanup but outlives a SIGKILLed
 * host.
 */

const SCRIPT = String.raw`
const { spawn, execFileSync } = require("node:child_process");
const [command, args, verbatim, graceMs, electronRunAsNode] = JSON.parse(process.argv[1]);
const windows = process.platform === "win32";
// The command gets the host's own ELECTRON_RUN_AS_NODE, not the one that made this watchdog run as Node.
const env = { ...process.env };
if (electronRunAsNode === null) { delete env.ELECTRON_RUN_AS_NODE; } else { env.ELECTRON_RUN_AS_NODE = electronRunAsNode; }
const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"], detached: !windows, windowsHide: true, windowsVerbatimArguments: verbatim });
let stopping = false;
const group = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
const stop = () => {
  if (stopping) { return; }
  stopping = true;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { return; }
  if (windows) {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10000 }); } catch { child.kill(); }
    return;
  }
  group("SIGTERM");
  setTimeout(() => { group("SIGKILL"); }, graceMs).unref();
};
child.once("error", () => { process.exit(1); });
child.once("exit", (code) => {
  // What it started may still be in its group.
  if (!windows && child.pid !== undefined) { group("SIGKILL"); }
  process.exit(code ?? 1);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) { process.on(signal, stop); }
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
`;

export interface WatchdogTarget {
  readonly command: string;
  readonly args: readonly string[];
  /** Node is started directly, never through cmd.exe. */
  readonly windowsVerbatimArguments?: true;
}

/**
 * The launch of `target` under the watchdog. The host must keep the child's
 * stdin open as a pipe for as long as the command should run: ending it
 * stops the command. The watchdog's own grace is half the host's
 * (`killGraceMs()`), so it escalates before the host's own SIGKILL would end
 * the watchdog first. Null in a compiled single executable host, which
 * cannot run it.
 */
export function hostWatchdogTarget(target: { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: true }, env: Readonly<NodeJS.ProcessEnv>): (WatchdogTarget & { readonly env: NodeJS.ProcessEnv }) | null {
  const node = nodeEvalExecutable();
  if (node === null) { return null; }
  const spec = [target.command, target.args, target.windowsVerbatimArguments === true, Math.floor(killGraceMs() / 2), env.ELECTRON_RUN_AS_NODE ?? null];
  return { command: node, args: ["-e", SCRIPT, JSON.stringify(spec)], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}
