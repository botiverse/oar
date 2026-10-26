import which from "which";

/** Resolve one executable through PATH (and PATHEXT on Windows) without spawning anything. */
export function resolveExecutable(executable: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  const key = (name: string): string | undefined => process.platform === "win32"
    ? Object.keys(env).toSorted().find((entry) => entry.toUpperCase() === name)
    : name;
  const path = env[key("PATH") ?? "PATH"] ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
  const pathExt = env[key("PATHEXT") ?? "PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM";
  // which treats empty options as absent and would restore the host PATH.
  // A nonempty equivalent preserves an explicitly empty search path.
  return which.sync(executable, { nothrow: true, path: path === "" ? "." : path, pathExt: pathExt === "" ? ";" : pathExt });
}

/**
 * Every match of an executable on PATH, in PATH order, like `which -a`; the
 * first is the one {@link resolveExecutable} returns. Raw: a folder listed
 * twice matches twice, and on Windows one folder can match once per PATHEXT
 * extension.
 */
export function resolveExecutableAll(executable: string): readonly string[] {
  return which.sync(executable, { all: true, nothrow: true }) ?? [];
}
