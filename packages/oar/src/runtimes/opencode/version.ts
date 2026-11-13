import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable } from "../../shared/executable/run.js";
import { sessionEnvironment } from "../../shared/environment.js";

/** A native release's numeric version; a prerelease suffix compares as its release. */
export interface OpencodeRelease { readonly major: 1 | 2; readonly minor: number; readonly patch: number }

/** The two independently maintained native lines share one command name. */
export async function opencodeRelease(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<OpencodeRelease> {
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
  const match = /^(?:opencode\s+)?v?([12])\.(\d+)\.(\d+)(?:\S*)$/u.exec(version.trim());
  const [, major, minor, patch] = match ?? [];
  if ((major === "1" || major === "2") && minor !== undefined && patch !== undefined) {
    return { major: major === "1" ? 1 : 2, minor: Number(minor), patch: Number(patch) };
  }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}

export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  const release = await opencodeRelease(installation, options);
  return release.major;
}

/** 2.3.0 runs subagents in the background and reports them through `opencode/session/child_update`. */
export function hasBackgroundChildUpdates(release: OpencodeRelease): boolean {
  return release.major === 2 && release.minor >= 3;
}
