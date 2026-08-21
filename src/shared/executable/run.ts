import { execFile } from "node:child_process";

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

export const runExecutable: ExecutableRunner = async (executable, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs ?? 5_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error !== null && "code" in error && typeof error.code === "number"
          ? error.code
          : null;
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode,
        });
      },
    );
  });
