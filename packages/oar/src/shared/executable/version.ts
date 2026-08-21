import { runExecutable } from "./run.js";

/**
 * Read one executable's `--version` first line.
 * Returns undefined when the executable rejects the flag; throws only when it cannot be spawned.
 */
export async function readExecutableVersion(executable: string): Promise<string | undefined> {
  const result = await runExecutable(executable, ["--version"]);
  if (!result.ok && result.exitCode === null) {
    throw new Error(`Failed to run ${executable} --version`);
  }
  if (!result.ok) {
    return undefined;
  }
  const line = result.stdout.trim().split(/\r?\n/u)[0];
  return line === undefined || line.length === 0 ? undefined : line;
}
