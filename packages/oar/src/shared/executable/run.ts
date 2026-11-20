import { spawn } from "node:child_process";
import { killGraceMs, killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup, trackOwnedProcess } from "./process.js";
import { nativeError, spawnChecked, stderrTail, type ProcessDiagnostics, type ProcessExitObservation, type ProcessTimeoutObservation } from "./diagnostics.js";
import { stopProbe } from "./probe-cleanup.js";
import { closePipesAfterExit } from "./pipe-close.js";
import { withHeldPipes, type HeldPipes } from "./process-cleanup.js";
import { windowsSpawnTarget } from "./windows-shim.js";

export interface ExecutableResult {
  /**
   * False also when OAR closed its end of the output pipes while processes
   * the command left still held them (`diagnostics.cleanup.heldPipes`):
   * the output may then be incomplete.
   */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly diagnostics?: ProcessDiagnostics;
}

export interface ExecutableRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Redirect stdout to a caller-owned file descriptor; stdout in the result is empty. */
  readonly stdoutFd?: number;
  /** Send private input over stdin and close it. Omission keeps the previous stdin behavior. */
  readonly input?: string;
  /** Stops the command; the result is then a failure with no exit code. */
  readonly signal?: AbortSignal;
}

export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: ExecutableRunOptions,
) => Promise<ExecutableResult>;

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export const runExecutable: ExecutableRunner = async (executable, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  // execFile does not forward `detached` to spawn. Own the actual process
  // group here too, so a hung probe's tools cannot outlive the host.
  const result = await new Promise<ExecutableResult>((resolve) => {
    const startedAt = performance.now();
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let failure: ReturnType<typeof nativeError> | null = null;
    let timedOut = false;
    let exitObservation: ProcessExitObservation | null = null;
    let closeObserved = false;
    let timeoutObservation: ProcessTimeoutObservation | null = null;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let escalation: NodeJS.Timeout | null = null;
    let settled = false;
    let settlingPipes = false;
    let heldPipes: HeldPipes | null = null;
    /** Settles once a stop's SIGKILL has been sent: the bounded wait for the pipes starts there. */
    let stopping: Promise<void> | null = null;
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer ?? undefined);
      clearTimeout(escalation ?? undefined);
      options.signal?.removeEventListener("abort", onAbort);
      const ok = code === 0 && signal === null && failure === null && !stopped;
      const exitCode = ok || failure !== null || stopped ? null : code;
      resolve({
        ok, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode,
        ...(ok ? {} : { diagnostics: {
          exitCode, signal, stderr: stderrTail(stderr.toString("utf8")),
          ...(timedOut ? { timeoutMs } : {}),
          ...(timeoutObservation === null ? {} : { timeoutObservation }),
          ...(failure === null ? {} : { error: failure }),
          ...(heldPipes === null ? {} : { cleanup: withHeldPipes(undefined, heldPipes) }),
        } }),
      });
    };
    /*
     * Once the command has exited, its output pipes close when what it
     * started lets go of them. Without a deadline, or once it is stopped
     * (the stop may be unable to reach them: another user's processes), that
     * wait is bounded, from the exit or from the stop's SIGKILL: past it OAR
     * closes its end, and the result fails as possibly incomplete, naming
     * the holders. It only bounds: `close` (every pipe at EOF) completes the
     * result at any time, so a stopped command that exits with its tools
     * returns at once, not after the kill grace.
     */
    let settlePipes: (() => void) | null = null;
    let stop: (() => void) | null = null;
    const onAbort = (): void => {
      failure ??= { code: "ABORT_ERR", message: "The operation was aborted" };
      stop?.();
    };
    try {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        throw Object.assign(new RangeError("timeoutMs must be a nonnegative integer"), { code: "ERR_OUT_OF_RANGE" });
      }
      // Both the direct shim target and the escaped cmd.exe fallback are
      // explicit executables: Node must not add a shell or quote again.
      const target = windowsSpawnTarget(executable, args, options);
      const child = spawnChecked(() => spawn(target.command, [...target.args], {
        cwd: options.cwd, env: options.env,
        stdio: ["pipe", options.stdoutFd ?? "pipe", "pipe"],
        detached: OWN_PROCESS_GROUP,
        windowsVerbatimArguments: target.windowsVerbatimArguments === true,
        windowsHide: true,
      }));
      trackOwnedProcess(child);
      // An exited group leader can leave descendants holding the pipes.
      // POSIX cleanup retains start identities beyond close; Windows uses taskkill.
      stop = (): void => {
        if (stopped) { return; }
        stopped = true;
        clearTimeout(timer ?? undefined);
        if (process.platform === "win32") {
          killProcessTree(child);
          escalation = setTimeout(() => { signalProcessGroup(child, "SIGKILL"); }, killGraceMs());
          escalation.unref();
        } else {
          stopping = stopProbe(child, killGraceMs());
        }
        settlePipes?.();
      };
      const append = (output: Buffer, chunk: Buffer, stream: string): Buffer => {
        const remaining = OUTPUT_LIMIT - output.length;
        const next = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))]);
        if (chunk.length > remaining) {
          failure ??= { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: `${stream} maxBuffer length exceeded` };
          stop?.();
        }
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, "stdout"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, "stderr"); });
      child.once("error", (error) => { failure ??= nativeError(error); });
      settlePipes = (): void => {
        if (settlingPipes || exitObservation === null || !stopped && timeoutMs > 0) { return; }
        settlingPipes = true;
        const exit = exitObservation;
        void (async (): Promise<void> => {
          try {
            // Before the SIGKILL, a holder may be the command's own tool about to be killed: not a holder to report.
            // While this waits, the pipes it would close are open handles that keep the event loop alive;
            // once they close, `close` has already completed the result without it.
            if (stopping !== null) { await stopping; }
            if (settled) { return; }
            heldPipes = await closePipesAfterExit(child, [{ name: "stdout", stream: child.stdout }, { name: "stderr", stream: child.stderr }]) ?? null;
            // Had `close` come meanwhile, the result is complete already and this does nothing.
            if (heldPipes === null) { return; }
            failure ??= { code: "OUTPUT_INCOMPLETE", message: "OAR closed its end of the output pipes while other processes still held them; the output may be incomplete" };
            complete(exit.exitCode, exit.signal);
          } catch (error) {
            // A failed wait must neither hang the result nor leave the pipes open.
            failure ??= error instanceof Error ? nativeError(error) : { message: String(error) };
            child.stdout?.destroy();
            child.stderr?.destroy();
            complete(exit.exitCode, exit.signal);
          }
        })();
      };
      child.once("exit", (exitCode, signal) => {
        exitObservation = { at: new Date().toISOString(), elapsedMs: performance.now() - startedAt, exitCode, signal };
        settlePipes?.();
      });
      // Every pipe at EOF: the result is complete, whether or not the bounded wait above is still running.
      // (OAR's own closing of held pipes reaches `close` only after that wait has recorded them.)
      child.once("close", (code, signal) => { closeObserved = true; complete(code, signal); });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          // Preserve the deadline's facts even when cleanup later produces exit and close.
          timeoutObservation = { at: new Date().toISOString(), elapsedMs: performance.now() - startedAt,
            exit: exitObservation, closeObserved };
          stop?.();
        }, timeoutMs);
        timer.unref();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) { onAbort(); }
      else if (options.input !== undefined) {
        child.stdin?.on("error", error => { failure ??= nativeError(error); stop?.(); });
        child.stdin?.end(options.input);
      }
    } catch (error) {
      if (!(error instanceof Error)) { throw error; }
      failure = nativeError(error);
      complete(null, null);
    }
  });
  return result;
};
