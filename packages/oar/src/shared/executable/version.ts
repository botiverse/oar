import { runExecutable } from "./run.js";

/** Picks the version out of `--version` stdout; the default takes the first line. */
export type VersionReader = (stdout: string) => string | undefined;

function firstLine(stdout: string): string | undefined {
  return stdout.trim().split(/\r?\n/u)[0];
}

/**
 * Read one executable's `--version`, its first line unless `read` picks another part.
 * Returns undefined when the executable rejects the flag; throws only when it cannot be spawned.
 */
export async function readExecutableVersion(
  executable: string,
  timeoutMs?: number,
  read: VersionReader = firstLine,
): Promise<string | undefined> {
  const result = await runExecutable(
    executable,
    ["--version"],
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (!result.ok && result.exitCode === null) {
    throw new Error(`Failed to run ${executable} --version`);
  }
  if (!result.ok) {
    return undefined;
  }
  const version = read(result.stdout)?.trim();
  return version === undefined || version.length === 0 ? undefined : version;
}
