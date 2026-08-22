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
}

export type ExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: ExecutableRunOptions,
) => Promise<ExecutableResult>;

export const runExecutable: ExecutableRunner = async (executable, args, options = {}) => {
  const result = await new Promise<ExecutableResult>((resolve) => {
    execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs ?? 5000,
        maxBuffer: 2 * 1024 * 1024,
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
  });
  return result;
};
