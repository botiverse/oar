import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import which from "which";

/*
 * A Windows npm/pnpm `.cmd` (or `.bat`) shim launched through a shell has its
 * arguments parsed twice: once by the shim's own `cmd.exe`, once by the shim
 * passing `%*` on. cross-spawn only double-escapes the first pass for shims
 * under `node_modules\.bin\`; a GLOBAL shim (`%APPDATA%\npm\claude.cmd`) is
 * only escaped once, so an argument with an odd number of double quotes followed by
 * a `cmd` metacharacter (`&`, `|`, `<`, `>`) is split at that character: the
 * tail is dropped, or, under `&`, run as a command. OAR puts host text in
 * `--append-system-prompt`, so this is an argument-injection hole on Windows.
 *
 * The fix is to not go through `cmd.exe` at all for the shims OAR's runtimes
 * actually use: read the shim, recover the native binary or Node script it
 * wraps (npm and pnpm global shims), and spawn that directly, with no shell.
 * Yarn's pure forwarding shims are followed to that same native target.
 * Unrecognized shims still need cmd.exe. That fallback quotes the command
 * and escapes arguments for BOTH passes, regardless of the shim's path.
 * Callers must use windowsVerbatimArguments so Node does not quote again.
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
 * (a hand-rolled `.cmd`) do not and the caller uses the shell fallback. Pure:
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

/** Yarn v1's entire outer shim is one relative batch target followed by %*. */
function forwardedShim(shimPath: string, text: string): string | null {
  const relative = /^@"%~dp0[\\/]([^"\r\n\0%!*?^<>|:]+\.(?:cmd|bat))"[\t ]*%\*$/iu.exec(text.trim())?.[1];
  if (relative === undefined || path.win32.isAbsolute(relative)) { return null; }
  return path.win32.resolve(path.win32.dirname(shimPath), relative);
}

/** Follow at most three pure forwarding wrappers; fallback uses the last shim reached. */
export function resolveWindowsShim(
  shimPath: string,
  read: (candidate: string) => string | null = readShim,
  exists: (candidate: string) => boolean = existsSync,
): ResolvedShim {
  let current = path.win32.normalize(shimPath);
  const visited = new Set([current.toLowerCase()]);
  for (let depth = 0; depth <= 3; depth += 1) {
    const text = read(current);
    if (text === null) { break; }
    const direct = parseWindowsShim(current, text, exists);
    if (direct !== null) { return direct; }
    const next = forwardedShim(current, text);
    if (depth === 3 || next === null || visited.has(next.toLowerCase()) || !exists(next)) { break; }
    visited.add(next.toLowerCase());
    current = next;
  }
  return { command: current, prefixArgs: [] };
}

const CMD_META = /[()[\]%!^"`<>&|;, *?]/gu;

/** One cmd.exe pass; spaces and quotes are escaped too. */
function escapeCmd(text: string): string {
  return text.replaceAll(CMD_META, "^$&");
}

/** Quote for the eventual program's argv, then protect both cmd.exe passes. */
export function escapeWindowsShimArgument(argument: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    // Backslashes preceding a quote must be doubled; the quote itself needs
    // one more slash. Elsewhere slashes are literal, including before ^.
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  quoted += `${"\\".repeat(backslashes * 2)}"`;
  return escapeCmd(escapeCmd(quoted));
}

interface WindowsSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolve?: (name: string) => string | null;
}

/** Windows variable names are case-insensitive; Node chooses the first sorted spelling. */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).toSorted().find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Search the child's cwd/PATH, without changing the host process's cwd. */
function resolveWindowsCommand(command: string, options: WindowsSpawnOptions): string | null {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const searchPath = windowsEnv(env, "PATH") ?? windowsEnv(process.env, "PATH") ?? "";
  const pathExt = windowsEnv(env, "PATHEXT") ?? windowsEnv(process.env, "PATHEXT");
  const directories = /[\\/]/u.test(command) ? [cwd] : [cwd, ...searchPath.split(";")];
  for (const directory of directories) {
    const candidate = path.win32.resolve(cwd, directory.replace(/^"(.*)"$/u, "$1"), command);
    const found = which.sync(candidate, { nothrow: true, ...(pathExt === undefined ? {} : { pathExt }) });
    if (found !== null) { return found; }
  }
  return null;
}

/**
 * Prefer the native target of a recognized shim. Otherwise explicitly invoke
 * cmd.exe with a quoted shim path and arguments escaped for its two passes.
 * Non-shim commands and non-Windows launches pass through unchanged.
 */
export function windowsSpawnTarget(
  command: string,
  args: readonly string[],
  options: WindowsSpawnOptions = {},
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: true } {
  if ((options.platform ?? process.platform) !== "win32") {
    return { command, args };
  }
  const resolved = (options.resolve === undefined ? resolveWindowsCommand(command, options) : options.resolve(command))
    ?? (isWindowsShim(command) ? path.win32.resolve(options.cwd ?? process.cwd(), command) : null);
  if (resolved === null || !isWindowsShim(resolved)) {
    return { command, args };
  }
  const shim = resolveWindowsShim(resolved);
  if (!isWindowsShim(shim.command)) {
    return { command: shim.command, args: [...shim.prefixArgs, ...args] };
  }
  if (args.some((argument) => argument.includes("\r") || argument.includes("\n") || argument.includes("\0"))) {
    throw new TypeError("OAR could not read or recognize this runtime's .cmd/.bat wrapper; cmd.exe cannot preserve arguments containing CR, LF, or NUL. Install the runtime with npm or pnpm so OAR can launch its executable directly.");
  }
  // The shim path is parsed once; its forwarded arguments are parsed twice.
  // /s removes the outer quote pair, leaving the escaped command line intact.
  const line = [escapeCmd(`"${shim.command}"`), ...args.map((argument) => escapeWindowsShimArgument(argument))].join(" ");
  const shell = windowsEnv(process.env, "COMSPEC") ?? "cmd.exe";
  const shellArgs = ["/d", "/s", "/c", `"${line}"`];
  // Count the escaped UTF-16 command line, including cmd's path, switches and
  // outer quotes. Native launches above are not subject to cmd's 8191 limit.
  if (`"${shell}" ${shellArgs.join(" ")}`.length > 8191) {
    throw new TypeError("OAR could not read or recognize this runtime's .cmd/.bat wrapper; the cmd.exe command line exceeds its 8191-character limit after escaping. Shorten the arguments or install the runtime with npm or pnpm so OAR can launch its executable directly.");
  }
  return {
    command: shell,
    args: shellArgs,
    windowsVerbatimArguments: true,
  };
}
