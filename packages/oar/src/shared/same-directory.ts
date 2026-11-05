/* oxlint-disable import/prefer-default-export -- the package exports names only. */
import { realpathSync } from "node:fs";
import path from "node:path";

function real(dir: string, paths: typeof path): string {
  try {
    return realpathSync(dir);
  } catch {
    return paths.resolve(dir);
  }
}

/** The same directory, spelled or linked differently. */
export function sameDirectory(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  // agy 1.5.0 reports Windows session/list cwd as /D:/path. Only remove
  // that URI-style drive prefix on Windows; POSIX paths remain literal.
  const normalize = (dir: string): string => platform === "win32" && /^\/[A-Za-z]:\//u.test(dir) ? dir.slice(1) : dir;
  const a = normalize(left);
  const b = normalize(right);
  return paths.resolve(a) === paths.resolve(b) || real(a, paths) === real(b, paths);
}
