import which from "which";

/** Resolve one executable through PATH (and PATHEXT on Windows) without spawning anything. */
export function resolveExecutable(executable: string): string | null {
  return which.sync(executable, { nothrow: true });
}
