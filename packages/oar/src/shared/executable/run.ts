import { spawn } from "node:child_process";
import { killGraceMs, OWN_PROCESS_GROUP, requiresShell, signalProcessGroup, trackOwnedProcess } from "./process.js";
import { nativeError, stderrTail, type ProcessDiagnostics } from "./diagnostics.js";

export interface ExecutableResult {
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
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let failure: ReturnType<typeof nativeError> | null = null;
    let timedOut = false;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let escalation: NodeJS.Timeout | null = null;
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
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
          ...(failure === null ? {} : { error: failure }),
        } }),
      });
    };
    let stop: (() => void) | null = null;
    const onAbort = (): void => {
      failure ??= { code: "ABORT_ERR", message: "The operation was aborted" };
      stop?.();
    };
    try {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        throw Object.assign(new RangeError("timeoutMs must be a nonnegative integer"), { code: "ERR_OUT_OF_RANGE" });
      }
      const child = spawn(executable, [...args], {
        cwd: options.cwd, env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: OWN_PROCESS_GROUP,
        // Keep the existing .cmd/.bat resolution on Windows.
        shell: requiresShell(executable, process.platform),
      });
      trackOwnedProcess(child);
      // An exited group leader can leave descendants holding the pipes.
      // Signal the group until close, and retain escalation until then.
      stop = (): void => {
        if (stopped) { return; }
        stopped = true;
        clearTimeout(timer ?? undefined);
        signalProcessGroup(child, "SIGTERM");
        escalation = setTimeout(() => { signalProcessGroup(child, "SIGKILL"); }, killGraceMs());
        escalation.unref();
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
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, "stdout"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, "stderr"); });
      child.once("error", (error) => { failure ??= nativeError(error); });
      child.once("close", complete);
      if (timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; stop?.(); }, timeoutMs);
        timer.unref();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) { onAbort(); }
    } catch (error) {
      if (!(error instanceof Error)) { throw error; }
      failure = nativeError(error);
      complete(null, null);
    }
  });
  return result;
};
