import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { killGraceMs, killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup } from "./process.js";

export interface IsolatedResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IsolatedRunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

const OUTPUT_LIMIT = 1024 * 1024;
/** After the command itself exits, how long a process it left holding the output pipes may keep them. */
const PIPE_DRAIN_MS = 2000;

function keepTail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

/** Stop the command and everything it started: its process group on POSIX, its process tree on Windows. */
function stopTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    killProcessTree(child);
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  // Kept after the command exits: what it started may outlive it holding the
  // group, and those get the SIGKILL too.
  setTimeout(() => {
    signalProcessGroup(child, "SIGKILL");
  }, killGraceMs()).unref();
}

/**
 * Run a command that may start others (an updater runs npm or `curl | sh`)
 * with no stdin, no controlling terminal (its own session and process group
 * on POSIX), and a timeout that stops the whole group rather than only the
 * command, so nothing is cut off midway without the caller seeing a timeout
 * or left running after it.
 */
export async function runIsolated(command: string, args: readonly string[], options: IsolatedRunOptions): Promise<IsolatedResult> {
  const child = spawn(command, [...args], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: OWN_PROCESS_GROUP,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const stop = { timedOut: false };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = keepTail(stdout + chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = keepTail(stderr + chunk);
  });
  const timer = setTimeout(() => {
    stop.timedOut = true;
    stopTree(child);
  }, options.timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => {
    let code: number | null = null;
    child.once("exit", (exit) => {
      code = exit;
      setTimeout(() => {
        resolve(code);
      }, PIPE_DRAIN_MS);
    });
    child.once("close", (exit: number | null) => {
      resolve(exit ?? code);
    });
    child.once("error", (error) => {
      stderr += error.message;
      resolve(null);
    });
  });
  clearTimeout(timer);
  return { exitCode: stop.timedOut ? null : exitCode, timedOut: stop.timedOut, stdout, stderr };
}
