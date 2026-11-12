import { spawn } from "node:child_process";
import { nodeEvalExecutable } from "./node-eval.js";
import { spawnChecked, StderrTail } from "./diagnostics.js";
import { killMarkedAsync, trackEnvironmentMarker } from "./environment-marker.js";
import { trackOwnedProcess } from "./ownership.js";
import { processShutdown } from "./process-shutdown.js";
import { killGraceMs, OWN_PROCESS_GROUP, signalProcessGroup } from "./process-signals.js";

/** How a Node script child ended, with the last 8 KiB of its stderr. */
export interface NodeScriptExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** A Node child running a script given on its command line, talking over Node IPC. */
export interface NodeScriptChild {
  readonly pid: number | undefined;
  /** False once the channel is gone; a message sent then is dropped, and the exit is what gets recorded. */
  send(message: object): boolean;
  onMessage(listener: (message: unknown) => void): void;
  /** Settles once the child exited (or could not be spawned) and the descendants seen before a stop were ended. */
  readonly exited: Promise<NodeScriptExit>;
  /**
   * Stop the child and the descendants found below it. First the process table is
   * read and the child's descendants remembered (by parent pid, so also
   * tools that lead process groups of their own). Then `ask` lets the child
   * stop itself, if given; after the grace period (`killGraceMs()`), or at
   * once without `ask`, SIGTERM to its process group, SIGKILL to the group
   * and the remembered descendants after another grace period (POSIX);
   * `taskkill /T /F` on its tree (Windows). Once the child exited, the
   * remembered descendants still running are sent SIGKILL
   * (process-shutdown.ts, `killTree`). `captureTree: false` skips the read,
 * for a child that starts nothing. Idempotent; settles with the exit.
   */
  stop(ask?: () => void, captureTree?: boolean): Promise<NodeScriptExit>;
}

/** How long the exit waits for stderr to drain after the process itself ended. */
const STDERR_DRAIN_MS = 250;

/**
 * Run `script` with this host's own Node (`process.execPath -e script
 * argument`), stdin ignored, stdout and stderr piped (stdout is drained
 * unread, stderr kept as a tail), and a Node IPC channel with `advanced`
 * serialization. The child is spawned detached on every platform. On POSIX
 * it leads its own process group. On Windows Node otherwise puts it in a job
 * object that ends it together with a dying host, before it can end its own
 * tree; the cost is that a detached Windows child has no console, so a
 * console program it starts without `windowsHide` may open a visible window
 * (process-signals.ts). The script itself must end its tree when its IPC
 * channel disconnects (the host died, SIGKILL included): nothing in the host
 * can then. It is tracked with `trackOwnedProcess`, so a host that calls
 * `process.exit` still ends it and its descendants. On any exit the child's
 * process group is sent SIGKILL (POSIX), which reaches what is left of it.
 * With `marker` (an `environment-marker.ts` entry the caller put in `env`),
 * every process of this user still carrying it is sent SIGKILL once the
 * child exited, for whatever reason (an asynchronous `/proc` scan, repeated
 * until a pass finds none, at most five), and from the host's own `exit`
 * hook (Linux only). The
 * caller sets the environment, including `ELECTRON_RUN_AS_NODE=1` when
 * `process.execPath` may be Electron. Throws in a compiled single executable
 * host (node-eval.ts), which cannot run one.
 */
export function spawnNodeScript(script: string, argument: string, env: NodeJS.ProcessEnv, marker?: string): NodeScriptChild {
  const node = nodeEvalExecutable();
  if (node === null) {
    throw new Error("this host is a compiled single executable (Node SEA or Bun standalone): its executable would start the application again instead of a Node script, so it cannot run a Node script child");
  }
  const child = spawnChecked(() => spawn(node, ["-e", script, argument], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
    detached: true,
    windowsHide: true,
  }));
  trackOwnedProcess(child);
  const releaseMarker = marker === undefined ? null : trackEnvironmentMarker(marker);
  const shutdown = processShutdown(child, { killTree: true });
  const stderr = new StderrTail();
  const stderrClosed = Promise.withResolvers<void>();
  child.stdout?.resume();
  // As for line processes, `OAR_CHILD_STDERR=inherit` also forwards it to the host's stderr.
  const inherit = process.env.OAR_CHILD_STDERR === "inherit";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.append(chunk);
    if (inherit) { process.stderr.write(chunk); }
  });
  child.stderr?.once("close", () => { stderrClosed.resolve(); });
  if (child.stderr === null) { stderrClosed.resolve(); }
  const ended = Promise.withResolvers<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>();
  let backstop: NodeJS.Timeout | undefined = undefined;
  child.once("exit", (code, signal) => {
    clearTimeout(backstop);
    // What it started may still be in its group (POSIX); the group is ours to end.
    if (OWN_PROCESS_GROUP && child.pid !== undefined) { signalProcessGroup(child, "SIGKILL"); }
    ended.resolve({ code, signal });
    shutdown.nativeExited();
  });
  child.on("error", (error) => {
    if (child.pid === undefined) {
      stderr.append(error.message);
      stderrClosed.resolve();
      ended.resolve({ code: null, signal: null });
      shutdown.nativeExited();
      releaseMarker?.();
    }
  });
  const exited = (async (): Promise<NodeScriptExit> => {
    const { code, signal } = await ended.promise;
    // And what it started that kept the marker, wherever it was reparented (Linux; read without blocking the loop).
    if (marker !== undefined && child.pid !== undefined) { await killMarkedAsync(marker); }
    releaseMarker?.();
    await shutdown.finished;
    const drained = Promise.withResolvers<void>();
    const timer = setTimeout(drained.resolve, STDERR_DRAIN_MS);
    await Promise.race([stderrClosed.promise, drained.promise]);
    clearTimeout(timer);
    return { code, signal, stderr: stderr.text() };
  })();
  const running = (): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  let stopping = false;
  return {
    pid: child.pid,
    send(message) {
      if (!child.connected) { return false; }
      return child.send(message, () => { /* A send error means the channel closed meanwhile: the exit is what gets recorded. */ });
    },
    onMessage(listener) { child.on("message", listener); },
    exited,
    async stop(ask, captureTree = true) {
      if (!stopping && running()) {
        stopping = true;
        // Remember its descendants while it still runs: once it is gone they are no longer below it.
        // A child known to start nothing skips the read (on Windows a process-table query of its own).
        if (captureTree) { await shutdown.prepare(); }
        if (ask !== undefined && running()) {
          shutdown.markNativeStop();
          ask();
          backstop = setTimeout(() => { shutdown.stop(); }, killGraceMs());
        } else {
          shutdown.stop();
        }
      }
      const exit = await exited;
      return exit;
    },
  };
}
