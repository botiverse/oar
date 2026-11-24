import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { runExecutable } from "../../shared/executable/run.js";
import { sessionEnvironment } from "../../shared/environment.js";

/** Numeric comparisons ignore suffixes; version retains the full release identifier. */
export interface OpencodeRelease { readonly major: 1 | 2; readonly minor: number; readonly patch: number; readonly version: string }

type VersionOptions = Pick<SessionOptions, "cwd" | "env"> & { readonly signal?: AbortSignal; readonly timeoutMs?: number };

/** Use the supplied native version line, probing only when it is absent. */
export async function opencodeVersionLine(installation: ExecutableInstallation, options?: VersionOptions): Promise<string> {
  let version = installation.version;
  if (version === undefined) {
    const result = await runExecutable(installation.command, ["--version"], {
      timeoutMs: options?.timeoutMs ?? 15_000,
      ...(options === undefined ? {} : { cwd: options.cwd, env: sessionEnvironment(options.env), ...(options.signal === undefined ? {} : { signal: options.signal }) }),
    });
    if (!result.ok) {
      throw processFailure("Failed to identify the opencode release line", result.diagnostics ?? { exitCode: result.exitCode, signal: null, stderr: result.stderr });
    }
    version = result.stdout.trim();
  }
  return version;
}

/** The two independently maintained native lines share one command name. */
export async function opencodeRelease(installation: ExecutableInstallation, options?: VersionOptions): Promise<OpencodeRelease> {
  const version = await opencodeVersionLine(installation, options);
  const release = parseOpencodeRelease(version);
  if (release !== undefined) { return release; }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}

/** Synchronous read of a `--version` line; undefined when it names neither line. */
export function parseOpencodeRelease(version: string): OpencodeRelease | undefined {
  const release = parseOpencodeVersionLine(version);
  return release?.major === "future" ? undefined : release;
}

/** Distinguish a newer native major from a malformed version response. */
export function parseOpencodeVersionLine(version: string): OpencodeRelease | { readonly major: "future" } | undefined {
  const match = /^(?:opencode\s+)?v?([1-9]\d*)\.(\d+)\.(\d+)(\S*)$/u.exec(version.trim());
  const [, major, minor, patch, suffix] = match ?? [];
  if ((major === "1" || major === "2") && minor !== undefined && patch !== undefined) {
    return { major: major === "1" ? 1 : 2, minor: Number(minor), patch: Number(patch), version: `${major}.${minor}.${patch}${suffix ?? ""}` };
  }
  return major === undefined ? undefined : { major: "future" };
}

export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  const release = await opencodeRelease(installation, options);
  return release.major;
}

/** A pre-release of the floor itself (`2.2.0-beta`) is below it: it may predate the measured behavior. */
export function atLeastV2(release: OpencodeRelease, floor: { readonly minor: number; readonly patch: number }): boolean {
  if (release.major !== 2) { return false; }
  if (release.minor !== floor.minor) { return release.minor > floor.minor; }
  if (release.patch !== floor.patch) { return release.patch > floor.patch; }
  return !/^\d+\.\d+\.\d+-/u.test(release.version);
}

/** 2.3.0 runs subagents in the background and reports them through `opencode/session/child_update`. */
export function hasBackgroundChildUpdates(release: OpencodeRelease): boolean {
  return atLeastV2(release, { minor: 3, patch: 0 });
}
