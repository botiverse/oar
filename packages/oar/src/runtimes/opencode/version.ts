import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable } from "../../shared/executable/run.js";
import { sessionEnvironment } from "../../shared/environment.js";

/** The two independently maintained native lines share one command name. */
export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  let version = installation.version;
  if (version === undefined) {
    const result = await runExecutable(installation.command, ["--version"], {
      timeoutMs: 15_000,
      ...(options === undefined ? {} : { cwd: options.cwd, env: sessionEnvironment(options.env) }),
    });
    if (!result.ok) {
      throw processFailure("Failed to identify the opencode release line", result.diagnostics ?? { exitCode: result.exitCode, signal: null, stderr: result.stderr });
    }
    version = result.stdout.trim();
  }
  const major = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:\S*)$/u.exec(version.trim())?.[1];
  if (major === "1" || major === "2") { return major === "1" ? 1 : 2; }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}
