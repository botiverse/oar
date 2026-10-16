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
 * The fix is to not go through `cmd.exe` at all: read the shim, recover the
 * interpreter and script it would run (every shim OAR launches wraps a Node
 * CLI), and spawn those directly. A `.exe` target needs no shim and no shell.
 * A shim OAR cannot read as one of the known shapes is refused by the caller
 * rather than run through the shell, so a new shim shape fails loud, never
 * silently unsafe.
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

/** The double-quoted tokens on the one shim line that forwards `%*`, in order. */
function forwardingTokens(text: string): readonly string[] | null {
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes("%*")) {
      continue;
    }
    const tokens = [...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? "");
    if (tokens.length > 0) {
      return tokens;
    }
  }
  return null;
}

/** Replace a shim's `%dp0%` (its own directory, with a trailing separator) and normalize to a Windows path. */
function expand(token: string, shimDir: string): string {
  return path.win32.normalize(token.replaceAll(/%dp0%/giu, `${shimDir}\\`));
}

/**
 * What a `.cmd`/`.bat` shim would run, or null when the text is not a shape
 * we recognize. Two shapes, from npm/cmd-shim by whether the package `bin`
 * is a script or a native binary: a Node CLI (`"%_prog%" "%dp0%\cli.js" %*`)
 * runs with the shim's bundled `node.exe` or `node` from PATH; a native exe
 * (`"%dp0%\tool.exe" %*`) runs directly. The target is the last forwarded
 * token that expands to one of those. Pure: `shimExists` decides whether the
 * bundled `node.exe` is present (the real check is the file system; a test
 * passes its own). The caller spawns `command` with
 * `[...prefixArgs, ...callerArgs]` and no shell.
 */
export function parseWindowsShim(shimPath: string, text: string, shimExists: (candidate: string) => boolean): ResolvedShim | null {
  const tokens = forwardingTokens(text);
  if (tokens === null) {
    return null;
  }
  const shimDir = path.win32.dirname(shimPath);
  const expanded = tokens.map((token) => expand(token, shimDir));
  const target = expanded.findLast((candidate) => SCRIPT.test(candidate) || NATIVE.test(candidate));
  if (target === undefined) {
    return null;
  }
  if (NATIVE.test(target)) {
    return { command: target, prefixArgs: [] };
  }
  // npm's node shims bundle `node.exe` beside the shim when present, else take `node` from PATH.
  const bundledNode = path.win32.join(shimDir, "node.exe");
  return { command: shimExists(bundledNode) ? bundledNode : "node", prefixArgs: [target] };
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
