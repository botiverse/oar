import { open } from "node:fs/promises";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";

/** The `dima` flags that choose which App Server a command connects to (and starts). */
const DAEMON_FLAGS = new Set(["--home", "--server", "--model-config"]);

/** The App Server selection in a session's `launchArgs`, as `flag value` pairs or `flag=value`. */
export function dimDaemonArgs(launchArgs: readonly string[] = []): readonly string[] {
  const args: string[] = [];
  for (let index = 0; index < launchArgs.length; index += 1) {
    const arg = launchArgs[index] ?? "";
    const flag = arg.split("=", 1)[0] ?? arg;
    if (!DAEMON_FLAGS.has(flag)) { continue; }
    if (arg.includes("=")) {
      args.push(arg);
    } else if (index + 1 < launchArgs.length) {
      args.push(arg, launchArgs[index + 1] ?? "");
      index += 1;
    }
  }
  return args;
}

/**
 * Dim keeps one App Server per home, shared by every client of that home.
 * Whichever client connects first starts it as its own child, and OAR ends a
 * disposed session's whole process tree: a server started by `dima acp`
 * would die with that session and take every other session of the home
 * with it. A short read (`runtime list`) connects first instead, so the
 * server outlives that command reparented, like one a user's `dima` started.
 */
export async function startDimDaemon(command: string, options: SessionOptions): Promise<void> {
  const args = ["runtime", "list", ...dimDaemonArgs(options.launchArgs)];
  const result = await runExecutable(command, args, { cwd: options.cwd, env: sessionEnvironment(options.env), timeoutMs: 60_000 });
  if (!result.ok) {
    const stderr = result.diagnostics?.stderr.trim() ?? "";
    const detail = [stderr, await daemonLogTail(stderr)].filter((line) => line !== "").join(": ");
    throw new Error(`dima ${args.slice(0, 2).join(" ")} could not reach Dim's App Server${detail === "" ? "" : `: ${detail}`}`);
  }
}

/** A server that exits at start names its log (`see <home>/rust/daemon.log`); its last line is the reason. */
export async function daemonLogTail(stderr: string): Promise<string> {
  const log = /see (?<log>.+?daemon\.log)$/mu.exec(stderr)?.groups?.log;
  if (log === undefined) { return ""; }
  const text = await readTail(log, LOG_TAIL_BYTES).catch(() => "");
  return text.trimEnd().split("\n").at(-1)?.trim() ?? "";
}

const LOG_TAIL_BYTES = 4096;

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
