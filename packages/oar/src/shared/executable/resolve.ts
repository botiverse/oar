import which from "which";

/** Resolve one executable through PATH (and PATHEXT on Windows) without spawning anything. */
export function resolveExecutable(executable: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  const options = executableSearchOptions(executable, env);
  return options === null ? null : which.sync(executable, { nothrow: true, ...options });
}

/**
 * Every match of an executable on PATH, in PATH order, like `which -a`; the
 * first is the one {@link resolveExecutable} returns. Raw: a folder listed
 * twice matches twice, and on Windows one folder can match once per PATHEXT
 * extension.
 */
export function resolveExecutableAll(executable: string, env: Readonly<NodeJS.ProcessEnv> = process.env): readonly string[] {
  const options = executableSearchOptions(executable, env);
  return options === null ? [] : which.sync(executable, { all: true, nothrow: true, ...options }) ?? [];
}

function executableSearchOptions(executable: string, env: Readonly<NodeJS.ProcessEnv>): { path: string; pathExt: string } | null {
  const key = (name: string): string | undefined => process.platform === "win32"
    ? Object.keys(env).toSorted().find((entry) => entry.toUpperCase() === name)
    : name;
  const path = env[key("PATH") ?? "PATH"] ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
  const pathExt = env[key("PATHEXT") ?? "PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM";
  if (path === "" && !executable.includes("/") && !executable.includes("\\")) { return null; }
  return { path: path === "" ? "." : path, pathExt: pathExt === "" ? ";" : pathExt };
}
