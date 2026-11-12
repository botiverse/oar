/* oxlint-disable eslint/max-lines -- One terminal: its launch, what it owns and how it ends it read together. */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnChecked } from "./diagnostics.js";
import { killMarkedAsync, newEnvironmentMarker, trackEnvironmentMarker } from "./environment-marker.js";

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

/**
 * One process as the kill sees it; `startedAt` tells it from a later process
 * that reused the pid. `groupId` is its process group, when the listing has it.
 */
export interface TerminalProcess { pid: number; parentPid: number; startedAt: string; groupId?: number }

/** What the terminal needs of the host; injectable so tests start and signal nothing. */
export interface ScriptTerminalHost {
  findScript(env: NodeJS.ProcessEnv): string | null;
  spawn: typeof spawn;
  /** Every process on the host. */
  listProcesses(): TerminalProcess[];
  /** `pid` below zero is a process group, as for `process.kill`. */
  signal(pid: number, signal: NodeJS.Signals): void;
  hostPid: number;
  /** Ends the processes started with this environment entry (Linux; see environment-marker.ts). */
  killMarked?(entry: string): Promise<void>;
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
        processes.push({ pid: Number(entry), parentPid: Number(fields[1]), groupId: Number(fields[2]), startedAt: fields[19] ?? "" });
      } catch {
        // Gone between the listing and the read.
      }
    }
    return processes;
  }
  try {
    const output = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 2000, env: process.env });
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      // The last group always takes part in a match.
      const startedAt = match?.[4];
      if (match && startedAt !== undefined) { processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), groupId: Number(match[3]), startedAt: startedAt.trim() }); }
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
 * - then runs the program, and once it exits ends the whole session (each
 *   member `pgrep -s` lists, else the shell's process group): whatever the program left
 *   behind there, even when it exits before the terminal could look at its
 *   processes. Only a process that left the session (`setsid`) escapes; on
 *   Linux the environment marker still finds it.
 *
 * util-linux takes the line as one `-c` string and runs it with $SHELL, so
 * SHELL is forced to /bin/sh; BSD (macOS) takes the command as arguments.
 */
export function scriptInvocation(input: OpenClaudeLimitResetTerminalInput, scriptPath: string, hostPid: number): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const watchdog = `( trap '' TERM; while kill -0 ${hostPid} 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 1; done; `
    + `kill -0 ${hostPid} 2>/dev/null || { pkill -TERM -s $$ || kill -TERM $$; sleep 2; pkill -KILL -s $$ || kill -KILL $$; } ) </dev/null >/dev/null 2>&1 &`;
  // Not `exec`: the shell outlives the program to end the session it leaves
  // behind, every other member first, so they are gone before `script` exits.
  const sessionEnd = `if command -v pgrep >/dev/null 2>&1; then for p in $(pgrep -s $$); do [ "$p" = "$$" ] || kill -KILL "$p" 2>/dev/null; done; else kill -KILL 0; fi`;
  const shellLine = `stty rows ${input.rows} cols ${input.cols} 2>/dev/null; ${watchdog} ${shellQuote(input.command)}; ${sessionEnd}`;
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

/** How often, at most, output prompts another look at the processes under `script`. */
const OBSERVE_EVERY_MS = 500;

/** Sessions still running, so a host that exits takes them with it. */
const liveTerminals = new Set<() => void>();
let exitHookInstalled = false;

/**
 * Runs `command` under `script`. Returns null when there is no `script`.
 *
 * `script` puts the program in a session of its own, so signalling `script`'s
 * process group does not reach it. `kill` therefore walks the process tree
 * under `script` and signals each process it finds. A process whose parent
 * exited first is no longer under `script`, so the terminal also keeps what
 * it saw while running (as output arrives): the program's own process
 * group, led by `script`'s child, and every process it found below `script`.
 * At kill it also signals the ones it saw that are still the same process
 * (same start time), and the members of that group while one of them is
 * such a process (a group id is not reused while any member lives); never a
 * pid that may have been reused, and nothing below `script` once it exited. On
 * Linux the program also starts with an environment marker, so kill finally
 * ends every process still carrying it, wherever it went, the way OAR ends
 * a Cursor child's (environment-marker.ts).
 */
export function openScriptTerminal(input: OpenClaudeLimitResetTerminalInput, host: ScriptTerminalHost = HOST): ClaudeLimitResetTerminal | null {
  const script = host.findScript(input.env);
  if (script === null || script === "") { return null; }
  const marker = newEnvironmentMarker("OAR_TERMINAL_CHILD");
  const invocation = scriptInvocation({ ...input, env: { ...input.env, [marker.name]: "1" } }, script, host.hostPid);
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
  /** Every process seen below `script` while it ran, by pid. */
  const seen = new Map<number, TerminalProcess>();
  let observedAt = 0;
  const observe = (now: readonly TerminalProcess[]): void => {
    // Once `script` has exited its pid may belong to someone else: nothing is looked up below it.
    if (child.pid === undefined || exited) { return; }
    observedAt = Date.now();
    for (const each of descendantsOf(child.pid, now)) { seen.set(each.pid, each); }
  };
  /** A process seen earlier that is still that process (same start time). */
  const stillSeen = (each: TerminalProcess): boolean => seen.get(each.pid)?.startedAt === each.startedAt;
  /**
   * Ours, now: below `script` while it runs; a process seen earlier that is
   * still the same process; or a member of a process group led by
   * `script`'s child, while that group still holds a process seen earlier
   * (a group id is not reused while any member lives, so such a group is
   * still the program's).
   */
  const ours = (now: readonly TerminalProcess[]): TerminalProcess[] => {
    if (child.pid === undefined) { return []; }
    const rootPid = child.pid;
    const leaders = new Set([...seen.values()].filter((each) => each.parentPid === rootPid).map((each) => each.pid));
    const liveGroups = new Set(now.filter((each) => stillSeen(each) && each.groupId !== undefined && leaders.has(each.groupId)).map((each) => each.groupId));
    const found = new Map<number, TerminalProcess>();
    if (!exited) {
      for (const each of descendantsOf(rootPid, now)) { found.set(each.pid, each); }
    }
    for (const each of now) {
      if (each.pid === rootPid || each.pid === host.hostPid || found.has(each.pid)) { continue; }
      if (stillSeen(each) || (each.groupId !== undefined && liveGroups.has(each.groupId))) { found.set(each.pid, each); }
    }
    return [...found.values()];
  };
  /** Signals what is ours now, and `script`'s own group while it runs. */
  const signalTree = (name: NodeJS.Signals): TerminalProcess[] => {
    if (child.pid === undefined) { return []; }
    const now = host.listProcesses();
    observe(now);
    const targets = ours(now);
    for (const each of targets) { signal(each.pid, name); }
    if (!exited) { signal(-child.pid, name); }
    return targets;
  };
  const onDaemonExit = (): void => {
    signalTree("SIGKILL");
  };
  const markExited = (): void => {
    if (exited) { return; }
    exited = true;
    for (const listener of exitListeners) { listener(); }
  };
  const releaseMarker = trackEnvironmentMarker(marker.entry);
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
      child.stdout.on("data", (chunk: Buffer) => {
        if (!exited && Date.now() - observedAt >= OBSERVE_EVERY_MS) { observe(host.listProcesses()); }
        listener(decoder.write(chunk));
      });
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
          if (left.length > 0 || !exited) {
            // Whatever ignored the request, and anything started since.
            for (const each of left) { signal(each.pid, "SIGKILL"); }
            const late = signalTree("SIGKILL");
            await waitGone([...left, ...late], KILL_WAIT_MS);
          }
          // What left the tree and the group but still carries the marker.
          await (host.killMarked === undefined ? killMarkedAsync(marker.entry) : host.killMarked(marker.entry));
        } finally {
          releaseMarker();
          liveTerminals.delete(onDaemonExit);
        }
      })();
      return killing;
    },
  };
}
