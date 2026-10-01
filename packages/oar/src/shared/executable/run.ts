import { execFile } from "node:child_process";
import { requiresShell } from "./process.js";

export interface ExecutableResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface ExecutableRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** End stdin at once, so a command that would prompt reads EOF instead of waiting. */
  readonly closeStdin?: boolean;
  /** Output cap in bytes (default 2 MiB); exceeding it kills the process. */
  readonly maxBuffer?: number;
}

export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: ExecutableRunOptions,
) => Promise<ExecutableResult>;

export const runExecutable: ExecutableRunner = async (executable, args, options = {}) => {
  const result = await new Promise<ExecutableResult>((resolve) => {
    const child = execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs ?? 5000,
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
        // Same Windows .cmd-shim rule as spawnLineProcess: modern Node throws
        // EINVAL (synchronously) on shell-less exec of .cmd/.bat.
        shell: requiresShell(executable, process.platform),
      },
      (error, stdout, stderr) => {
        const exitCode = error !== null && "code" in error && typeof error.code === "number"
          ? error.code
          : null;
        resolve({
          ok: error === null,
          stdout,
          stderr,
          exitCode,
        });
      },
    );
    if (options.closeStdin === true) {
      child.stdin?.end();
    }
  });
  return result;
};
