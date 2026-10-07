import { execFile, type ExecException } from "node:child_process";
import { requiresShell } from "./process.js";
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

export const runExecutable: ExecutableRunner = async (executable, args, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const result = await new Promise<ExecutableResult>((resolve) => {
    const complete = (error: (Error & Pick<ExecException, "code" | "signal" | "killed">) | null, stdout: string, stderr: string): void => {
      const exitCode = error !== null && typeof error.code === "number" ? error.code : null;
      resolve({
        ok: error === null,
        stdout,
        stderr,
        exitCode,
        ...(error === null ? {} : {
          diagnostics: {
            exitCode,
            signal: error.signal ?? null,
            stderr: stderrTail(stderr),
            // maxBuffer also kills the child, but supplies its own string
            // error code. Only the timer kill is a timeout.
            ...(error.killed === true && typeof error.code !== "string" ? { timeoutMs } : {}),
            ...(typeof error.code === "string" || (error.code === undefined && error.signal === undefined && error.killed !== true)
              ? { error: nativeError(error) } : {}),
          },
        }),
      });
    };
    try {
      execFile(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        timeout: timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxBuffer: 2 * 1024 * 1024,
        // Modern Node rejects shell-less execution of Windows .cmd/.bat shims.
        shell: requiresShell(executable, process.platform),
      }, complete);
    } catch (error) {
      // Spawn can fail synchronously too (for example EINVAL on Windows).
      if (!(error instanceof Error)) {
        throw error;
      }
      complete(error, "", "");
    }
  });
  return result;
};
