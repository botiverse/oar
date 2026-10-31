/* oxlint-disable import/max-dependencies -- This process owner composes spawn, streams, diagnostics, observation and shutdown. */
import spawn from "cross-spawn";
import { Duplex, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { nativeError, spawnChecked, spawnFailure, StderrTail, type ProcessDiagnostics } from "./diagnostics.js";
import { trackOwnedProcess } from "./ownership.js";
import { treeResourcesReader } from "./process-resources.js";
import type { CancellationObservation } from "./process-cancellation.js";
import { processShutdown } from "./process-shutdown.js";
import { OWN_PROCESS_GROUP } from "./process-signals.js";
import { windowsSpawnTarget } from "./windows-shim.js";
import { prepareProcessTable, processTablePreparation } from "./process-table-preparation.js";

export { trackOwnedProcess } from "./ownership.js";
export { killGraceMs, KILL_GRACE_MS, killProcessTree, signalProcessGroup, OWN_PROCESS_GROUP } from "./process-signals.js";
export interface LineProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Forward the child's stderr to the host's stderr. Defaults to
   * `OAR_CHILD_STDERR=inherit`; a child whose output must stay inside oar
   * (a login) passes false.
   */
  readonly inheritStderr?: boolean;
  /**
   * `kill()` ends the child's whole process tree. On Windows
   * (killProcessTree) that is more than the direct child, which for an
   * npm `.cmd` shim is only `cmd.exe`. Captured start identities also reach
   * Windows tools whose intermediate parent exits before taskkill walks it.
   * On POSIX, where the child's process group is always signalled, it adds the descendants that left the group
   * (process-tree.ts): SIGTERM still goes to the group alone, so the child
   * can stop its tools itself; the SIGKILL, or the child's exit if that comes
   * first, also takes every descendant seen before (when `kill()` began, and
   * again just before the SIGKILL) and the groups they belong to.
   */
  readonly killTree?: boolean;
  /** Let EOF run native shutdown hooks before the bounded force-kill. */
  readonly shutdown?: "stdin";
  /** Open a private bidirectional pipe at child fd 3, separate from stdout. */
  readonly extraPipe?: boolean;
}
/** A long-lived child whose raw streams can also be observed line-by-line. */
export interface LineProcess {
  /** Resolves once the OS process exists; rejects when it cannot be spawned. */
  readonly spawned: Promise<void>;
  /**
   * Resolves when the process is truly gone and its state has been released.
   * After `kill()`, it includes bounded observations around the SIGKILL
   * escalation and any asynchronous descendant cleanup after native exit.
   */
  readonly exited: Promise<number | null>;
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Present only when extraPipe was requested; the caller owns its protocol. */
  readonly extraPipe?: Duplex;
  /** Native status and the last 8 KiB of stderr observed so far. */
  diagnostics(): ProcessDiagnostics;
  /** True immediately when kill begins, before asynchronous capture or EOF. */
  stopping(): boolean;
  /** Only immediately before stopping: memoizes descendant capture and registers exit cleanup. */
  prepareShutdown(): Promise<void>;
  /** Record the actual native stop attempt, immediately before sending cancel/close. */
  markNativeStop(): void;
  /** Stage one fresh, bounded observation before a reusable turn cancellation. */
  observeCancellation(): Promise<CancellationObservation>;
  write(text: string): void;
  /** Complete UTF-8 lines, independent of stdout byte-chunk boundaries. */
  onLine(handler: (line: string) => void): void;
  /** Fires exactly once, for exit or spawn-level error alike. */
  onExit(handler: (code: number | null, reason?: string) => void): void;
  /**
   * Stop the process and everything it started: close stdin, SIGTERM its
   * process group (unless shutdown is stdin), and SIGKILL the group if the child is still running once
   * the grace period is over; with `killTree`, its descendants outside the
   * group too. On Windows it ends the child alone, or its whole tree with
   * `killTree`. Idempotent; a no-op after the exit, since a reaped pid may
   * already belong to another process.
   */
  kill(): void;
  /** The child's memory with its group and descendants (process-resources.ts); null once it has exited. */
  readonly resources: ReturnType<typeof treeResourcesReader>;
}
/**
 * Spawn through cross-spawn. On Windows a `.cmd`/`.bat` shim is first
 * resolved to its native target or an explicitly escaped cmd.exe invocation.
 * Line parsing is attached lazily; protocol SDKs can consume the raw streams.
 */
export function spawnLineProcess(
  command: string,
  args: readonly string[],
  options: LineProcessOptions = {},
): LineProcess {
  const target = windowsSpawnTarget(command, args, options);
  const child = spawnChecked(() => spawn(target.command, [...target.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdio: options.extraPipe === true ? ["pipe", "pipe", "pipe", "overlapped"] : ["pipe", "pipe", "pipe"], // Child async I/O needs Windows FILE_FLAG_OVERLAPPED.
    detached: OWN_PROCESS_GROUP,
    windowsVerbatimArguments: target.windowsVerbatimArguments === true,
  }));
  trackOwnedProcess(child);
  const { stdin, stdout } = child;
  const stderr = new StderrTail();
  const inheritStderr = options.inheritStderr ?? process.env.OAR_CHILD_STDERR === "inherit";
  // Always drain stderr, even after the tail is full and without a host
  // observer. Otherwise a verbose child can block before its next RPC reply.
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.append(chunk);
    if (inheritStderr) {
      process.stderr.write(chunk);
    }
  });
  if (stdin === null || stdout === null) {
    throw new Error("line process stdio must be piped");
  }
  stdin.on("error", () => {}); // EPIPE from a child already gone: its exit is what gets recorded.
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null, reason?: string) => void)[] = [];
  let buffer = "";
  let readingLines = false;
  let ended = false;
  let finalized = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: ProcessDiagnostics["error"] = undefined;
  const shutdown = processShutdown(child, options);
  const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers<void>();
  const exited = (async (): Promise<number | null> => {
    await shutdown.finished;
    finalized = true;
    for (const handler of exitHandlers) { handler(exitCode, shutdown.reason()); }
    return exitCode;
  })();
  child.once("spawn", () => {
    spawnOk();
    if (options.killTree === true) { prepareProcessTable(); }
  });
  const end = (code: number | null, signal: NodeJS.Signals | null = null): void => {
    if (ended) {
      return;
    }
    ended = true;
    exitCode = code;
    exitSignal = signal;
    shutdown.nativeExited();
  };
  child.on("exit", end);
  child.on("error", (error) => {
    spawnError = nativeError(error);
    spawnFailed(spawnFailure(error));
    end(null);
  });
  const readLines = (): void => {
    // Keep incomplete UTF-8 code points between chunks without changing the
    // raw stdout stream used by protocol SDKs and other observers.
    const decoder = new StringDecoder("utf8");
    stdout.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line.length > 0) {
          for (const handler of lineHandlers) {
            handler(line);
          }
        }
      }
    });
  };

  return {
    spawned,
    exited,
    stdin,
    stdout,
    stopping: () => shutdown.stopping(),
    prepareShutdown: async () => { await shutdown.prepare(); },
    markNativeStop: () => { shutdown.markNativeStop(); },
    observeCancellation: async () => { const observation = await shutdown.observeCancellation(); return observation; },
    ...(child.stdio[3] instanceof Duplex ? { extraPipe: child.stdio[3] } : {}),
    diagnostics: () => {
      const cleanup = shutdown.diagnostics();
      const preparation = options.killTree === true ? processTablePreparation() : undefined;
      return { exitCode, signal: exitSignal, stderr: stderr.text(),
        ...(spawnError === undefined ? {} : { error: spawnError }),
        ...(cleanup === undefined ? {} : { cleanup }),
        ...(preparation === undefined ? {} : { processTablePreparation: preparation }),
      };
    },
    // Stop accepting writes immediately, including while capture awaits EOF.
    write: (text) => { if (!shutdown.stopping() && !ended && !stdin.writableEnded && !stdin.destroyed) { stdin.write(text); } },
    onLine(handler) {
      lineHandlers.push(handler);
      if (!readingLines) {
        readingLines = true;
        readLines();
      }
    },
    onExit(handler) {
      if (finalized) {
        queueMicrotask(() => {
          handler(exitCode, shutdown.reason());
        });
      } else {
        exitHandlers.push(handler);
      }
    },
    resources: treeResourcesReader(child, () => ended),
    kill: () => { shutdown.stop(); },
  };
}
