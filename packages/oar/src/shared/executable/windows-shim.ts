import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveExecutable } from "./resolve.js";

/*
 * A Windows npm/pnpm `.cmd` (or `.bat`) shim launched through a shell has its
 * arguments parsed twice: once by the shim's own `cmd.exe`, once by the shim
 * passing `%*` on. cross-spawn only double-escapes the first pass for shims
 * under `node_modules\.bin\`; a GLOBAL shim (`%APPDATA%\npm\claude.cmd`) is
 * not escaped, so an argument with an odd number of double quotes followed by
 * a `cmd` metacharacter (`&`, `|`, `<`, `>`) is split at that character: the
 * tail is dropped, or, under `&`, run as a command. OAR puts host text in
 * `--append-system-prompt`, so this is an argument-injection hole on Windows.
 *
 * The fix is to not go through `cmd.exe` at all for the shims OAR's runtimes
 * actually use: read the shim, recover the native binary or Node script it
 * wraps (npm and pnpm global shims), and spawn that directly, with no shell.
 * A shape neither package manager emits is not recognized; the caller then
 * launches it as before (through cross-spawn, which may use `cmd.exe`), so a
 * runtime installed some other way still starts. This fallback is fail-open:
 * a shim OAR cannot read, if it were a global shell shim, would carry the
 * same single-escape risk. Closing it for every shape (a generic `cmd.exe`
 * double-escape) is tracked separately; the shims OAR installs are covered.
 */

/** What to spawn in place of a shim: the interpreter and the arguments that go before the caller's own. */
export interface ResolvedShim {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

const SHIM = /\.(?:cmd|bat)$/iu;
const SCRIPT = /\.(?:c|m)?js$/iu;
const NATIVE = /\.(?:exe|com)$/iu;

/** Whether a resolved command is a Windows shell shim (`.cmd`/`.bat`), the only commands that go through `cmd.exe`. */
export function isWindowsShim(command: string): boolean {
  return SHIM.test(command);
}

/** Every double-quoted token in the shim text, in order. */
function quotedTokens(text: string): readonly string[] {
  return [...text.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? "");
}

/** A token naming the shim's own directory: npm's `%dp0%` or pnpm's `%~dp0`. */
function isShimRelative(token: string): boolean {
  return /%(?:~)?dp0%?/iu.test(token);
}

/** Replace a shim's own-directory variable (`%dp0%` or `%~dp0`) and normalize to a Windows path. */
function expand(token: string, shimDir: string): string {
  return path.win32.normalize(token.replaceAll(/%dp0%|%~dp0/giu, `${shimDir}\\`));
}

/** `node` from a shim, bare or shim-relative; not the script it runs. */
function isNodeBinary(candidate: string): boolean {
  return /(?:^|[\\/])node\.exe$/iu.test(candidate);
}

/**
 * What a global package-manager shim (`.cmd`/`.bat`) would run, or null when
 * the text is not a shim shape we recognize. npm and pnpm both wrap a
 * package's `bin`, naming every path relative to the shim's own directory
 * (`%dp0%` / `%~dp0`) and forwarding exactly `%*`:
 * - a native binary (claude's `claude.exe`) runs directly;
 * - a Node script (codex's `codex.js`) runs with the shim's own `node.exe`
 *   when it sits beside the shim, else `node` from PATH.
 *
 * Recognized by the shim-relative target alone, so npm's and pnpm's differing
 * boilerplate both match, while an absolute target or extra fixed arguments
 * (a hand-rolled `.cmd`) do not and the caller launches it unchanged. Pure:
 * `shimExists` decides whether the bundled `node.exe` is present (the real
 * check is the file system; a test passes its own). The caller spawns
 * `command` with `[...prefixArgs, ...callerArgs]` and no shell.
 */
export function parseWindowsShim(shimPath: string, text: string, shimExists: (candidate: string) => boolean): ResolvedShim | null {
  if (!text.includes("%*")) {
    return null;
  }
  const shimDir = path.win32.dirname(shimPath);
  const relative = [...new Set(quotedTokens(text).filter((token) => isShimRelative(token)).map((token) => expand(token, shimDir)))];
  // The shim's own `node.exe` is the interpreter, not the target it runs.
  const scripts = relative.filter((candidate) => SCRIPT.test(candidate));
  const natives = relative.filter((candidate) => NATIVE.test(candidate) && !isNodeBinary(candidate));
  if (scripts.length === 1 && natives.length === 0) {
    const bundledNode = path.win32.join(shimDir, "node.exe");
    return { command: shimExists(bundledNode) ? bundledNode : "node", prefixArgs: [scripts[0] ?? ""] };
  }
  if (natives.length === 1 && scripts.length === 0) {
    return { command: natives[0] ?? "", prefixArgs: [] };
  }
  return null;
}

/** A shim's text, or null when it cannot be read. */
function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The command and arguments to spawn, with no shell, when a `.cmd`/`.bat`
 * shim can be read as the Node CLI it wraps: the interpreter and script it
 * would run, with the shim's own arguments ahead of the caller's, so nothing
 * reaches `cmd.exe`. Off Windows, for a non-shim command, or for a shim this
 * cannot read as a Node CLI, the inputs unchanged, so the caller spawns as
 * before (cross-spawn's shim handling). `resolve` finds a bare command on
 * PATH (its own default).
 */
export function windowsSpawnTarget(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  resolve: (name: string) => string | null = resolveExecutable,
): { readonly command: string; readonly args: readonly string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const resolved = isWindowsShim(command) ? command : resolve(command);
  if (resolved === null || !isWindowsShim(resolved)) {
    return { command, args };
  }
  const text = readShim(resolved);
  const shim = text === null ? null : parseWindowsShim(resolved, text, existsSync);
  return shim === null ? { command, args } : { command: shim.command, args: [...shim.prefixArgs, ...args] };
}
