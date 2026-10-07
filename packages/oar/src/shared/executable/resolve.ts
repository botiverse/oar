import which from "which";

/** Resolve one executable through PATH (and PATHEXT on Windows) without spawning anything. */
export function resolveExecutable(executable: string): string | null {
  return which.sync(executable, { nothrow: true });
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
