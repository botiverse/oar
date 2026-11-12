import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnChecked } from "./diagnostics.js";

/** A program running in a pseudo-terminal: what it draws, and its keyboard. */
export interface ClaudeLimitResetTerminal {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: () => void): void;
  /**
   * Ends everything this terminal started (the program, its children, the
   * pseudo-terminal helper) and nothing else. Resolves once they are gone, or
   * after a bounded wait.
   */
  kill(): Promise<void>;
}

export interface OpenClaudeLimitResetTerminalInput {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  platform: NodeJS.Platform;
}

export type OpenClaudeLimitResetTerminal = (input: OpenClaudeLimitResetTerminalInput) => ClaudeLimitResetTerminal | null;

/** How long processes asked to end get before they are killed outright, and how long that is waited for. */
const KILL_GRACE_MS = 2000;
const KILL_WAIT_MS = 1000;
const KILL_POLL_MS = 50;

/** One process as the kill sees it; `startedAt` tells it from a later process that reused the pid. */
export interface TerminalProcess { pid: number; parentPid: number; startedAt: string }

/** What the terminal needs of the host; injectable so tests start and signal nothing. */
export interface ScriptTerminalHost {
  findScript(env: NodeJS.ProcessEnv): string | null;
  spawn: typeof spawn;
  /** Every process on the host. */
  listProcesses(): TerminalProcess[];
  /** `pid` below zero is a process group, as for `process.kill`. */
  signal(pid: number, signal: NodeJS.Signals): void;
  hostPid: number;
}

/** The system `script` utility, which gives a child a pseudo-terminal with no native module. */
export function findScriptUtility(env: NodeJS.ProcessEnv = process.env): string | null {
  const directories = [...(env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0), "/usr/bin", "/bin"];
  for (const directory of directories) {
    const candidate = path.join(directory, "script");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return null;
}

/** Linux reads /proc; elsewhere `ps` (the BSD branch, which nothing exercises yet). */
function listHostProcesses(): TerminalProcess[] {
  const processes: TerminalProcess[] = [];
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) { continue; }
      try {
        // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read from the last ")".
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[0] === "Z") { continue; }
        processes.push({ pid: Number(entry), parentPid: Number(fields[1]), startedAt: fields[19] ?? "" });
      } catch {
        // Gone between the listing and the read.
      }
    }
    return processes;
  }
  try {
    const output = execFileSync("ps", ["-Ao", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 2000, env: process.env });
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      // The last group always takes part in a match.
      const startedAt = match?.[3];
      if (match && startedAt !== undefined) { processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: startedAt.trim() }); }
    }
  } catch {
    // No listing: only the process group can be signalled.
  }
  return processes;
}

const HOST: ScriptTerminalHost = {
  findScript: findScriptUtility,
  spawn,
  listProcesses: listHostProcesses,
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  hostPid: process.pid,
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * How `command` is run under `script`. The shell line:
 *
 * - sizes the terminal first: `script` fed from a pipe has no window size to
 *   copy;
 * - leaves a watchdog behind that ends the program if the host dies while
 *   it runs (a killed host can run no cleanup of its own). `$$` is the
 *   shell's pid, which `exec` hands to the program; the watchdog stops as
 *   soon as either is gone. `script` makes that shell a session leader, so
 *   `$$` is also the session's id: the watchdog ends the whole session (the
 *   program and what it started: MCP servers, hooks), TERM first, then KILL,
 *   and the program alone where `pkill` is missing. It ignores TERM itself so
 *   it lives to send the KILL, which ends it too;
 * - then becomes the program.
 *
 * util-linux takes the line as one `-c` string and runs it with $SHELL, so
 * SHELL is forced to /bin/sh; BSD (macOS) takes the command as arguments.
 */
export function scriptInvocation(input: OpenClaudeLimitResetTerminalInput, scriptPath: string, hostPid: number): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const watchdog = `( trap '' TERM; while kill -0 ${hostPid} 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 1; done; `
    + `kill -0 ${hostPid} 2>/dev/null || { pkill -TERM -s $$ || kill -TERM $$; sleep 2; pkill -KILL -s $$ || kill -KILL $$; } ) </dev/null >/dev/null 2>&1 &`;
  const shellLine = `stty rows ${input.rows} cols ${input.cols} 2>/dev/null; ${watchdog} exec ${shellQuote(input.command)}`;
  return {
    file: scriptPath,
    args: input.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", shellLine]
      : ["-qfc", shellLine, "/dev/null"],
    env: { ...input.env, SHELL: "/bin/sh", TERM: "xterm-256color", COLUMNS: String(input.cols), LINES: String(input.rows) },
  };
}

/** Everything under `rootPid` in the process tree, nearest first. */
function descendantsOf(rootPid: number, processes: readonly TerminalProcess[]): TerminalProcess[] {
  const found: TerminalProcess[] = [];
  const parents = [rootPid];
  // `parents` grows while it is walked; an array iterator reads its length at every step.
  for (const parent of parents) {
    for (const each of processes) {
      if (each.parentPid !== parent || found.some((known) => known.pid === each.pid)) { continue; }
      found.push(each);
      parents.push(each.pid);
    }
  }
  return found;
}

/** Sessions still running, so a host that exits takes them with it. */
const liveTerminals = new Set<() => void>();
let exitHookInstalled = false;

/**
 * Runs `command` under `script`. Returns null when there is no `script`.
 *
 * `script` puts the program in a session of its own, so signalling `script`'s
 * process group does not reach it. `kill` therefore walks the process tree
 * under `script` and signals each process it finds.
 */
export function openScriptTerminal(input: OpenClaudeLimitResetTerminalInput, host: ScriptTerminalHost = HOST): ClaudeLimitResetTerminal | null {
  const script = host.findScript(input.env);
  if (script === null || script === "") { return null; }
  const invocation = scriptInvocation(input, script, host.hostPid);
  // A value Node refuses (a NUL byte) is cut from the error: env may hold the account's secrets.
  const child = spawnChecked(() => host.spawn(invocation.file, invocation.args, {
    cwd: input.cwd,
    env: invocation.env,
    // Its own process group, so ending it never reaches the host's.
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  }));
  const decoder = new StringDecoder("utf8");
  let exited = false;
  let killing: Promise<void> | null = null;
  const exitListeners: (() => void)[] = [];
  const signal = (pid: number, name: NodeJS.Signals): void => {
    try {
      host.signal(pid, name);
    } catch {
      // Already gone.
    }
  };
  /** The processes under `script` right now, and `script`'s own group. */
  const signalTree = (name: NodeJS.Signals): TerminalProcess[] => {
    if (child.pid === undefined) { return []; }
    const tree = descendantsOf(child.pid, host.listProcesses());
    for (const each of tree) { signal(each.pid, name); }
    if (!exited) { signal(-child.pid, name); }
    return tree;
  };
  const onDaemonExit = (): void => {
    signalTree("SIGKILL");
  };
  const markExited = (): void => {
    if (exited) { return; }
    exited = true;
    for (const listener of exitListeners) { listener(); }
  };
  child.once("exit", markExited);
  child.once("error", markExited);
  child.stdin.on("error", () => {});
  liveTerminals.add(onDaemonExit);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const end of liveTerminals) { end(); }
    });
  }

  const stillRunning = (targets: readonly TerminalProcess[]): TerminalProcess[] => {
    const now = host.listProcesses();
    return targets.filter((target) => now.some((each) => each.pid === target.pid && each.startedAt === target.startedAt));
  };
  const waitGone = async (targets: readonly TerminalProcess[], withinMs: number): Promise<TerminalProcess[]> => {
    let left = stillRunning(targets);
    for (let waited = 0; waited < withinMs; waited += KILL_POLL_MS) {
      // `exited` is set by the child's exit event while this waits.
      if (left.length === 0 && exited) { break; }
      await new Promise((resolve) => { setTimeout(resolve, KILL_POLL_MS); });
      left = stillRunning(targets);
    }
    return left;
  };

  return {
    write: (data) => {
      if (!exited && child.stdin.writable) { child.stdin.write(data); }
    },
    onData: (listener) => {
      child.stdout.on("data", (chunk: Buffer) => { listener(decoder.write(chunk)); });
    },
    onExit: (listener) => {
      if (exited) { listener(); }
      else { exitListeners.push(listener); }
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Every call returns the one kill in progress, the same promise.
    kill: () => {
      killing ??= (async (): Promise<void> => {
        try {
          const asked = signalTree("SIGTERM");
          const left = await waitGone(asked, KILL_GRACE_MS);
          if (left.length === 0 && exited) { return; }
          // Whatever ignored the request, and anything started since.
          for (const each of left) { signal(each.pid, "SIGKILL"); }
          const late = signalTree("SIGKILL");
          await waitGone([...left, ...late], KILL_WAIT_MS);
        } finally {
          liveTerminals.delete(onDaemonExit);
        }
      })();
      return killing;
    },
  };
}
