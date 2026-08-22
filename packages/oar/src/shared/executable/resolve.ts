import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** The one execFileSync shape resolution needs — a typed seam for tests. */
export type ExecFileSyncLike = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly encoding: "utf8";
    readonly stdio: readonly ["ignore", "pipe", "ignore"];
    readonly timeout?: number;
  },
) => string | Buffer;

export interface ExecutableResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly execFileSyncFn?: ExecFileSyncLike;
  readonly existsSyncFn?: (filePath: string) => boolean;
}

function firstLine(value: string | Buffer): string | null {
  const line = (typeof value === "string" ? value : value.toString()).trim().split(/\r?\n/u)[0];
  return line === undefined || line.length === 0 ? null : line;
}

function resolveWindows(
  executable: string,
  env: NodeJS.ProcessEnv,
  execFile: ExecFileSyncLike,
  exists: (filePath: string) => boolean,
): string | null {
  // The name travels via env, NOT as a trailing argument: powershell -Command
  // appends trailing arguments to the command string instead of binding $args,
  // which silently resolved nothing (caught by CI once Windows ran for real).
  const script = [
    "$cmd = Get-Command -Name $env:OAR_RESOLVE_TARGET -ErrorAction Stop | Select-Object -First 1",
    "if ($cmd.Path) { $cmd.Path } elseif ($cmd.Source) { $cmd.Source }",
  ].join("; ");
  try {
    const resolved = firstLine(execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      // Cold powershell startup on CI runners routinely exceeds 1s; keep this
      // generous — resolution is rare and cached by callers, not hot-path.
      {
        env: { ...env, OAR_RESOLVE_TARGET: executable },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      },
    ));
    if (resolved === null || !resolved.toLowerCase().endsWith(".ps1")) {
      return resolved;
    }
    const directory = path.dirname(resolved);
    const base = path.basename(resolved, ".ps1");
    for (const extension of [".cmd", ".bat", ".exe", ""]) {
      const candidate = path.join(directory, `${base}${extension}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve one executable without invoking a shell. */
export function resolveExecutable(
  executable: string,
  options: ExecutableResolveOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execFile = options.execFileSyncFn ?? execFileSync;
  const exists = options.existsSyncFn ?? existsSync;
  if (platform === "win32") {
    return resolveWindows(executable, env, execFile, exists);
  }
  try {
    return firstLine(execFile("which", [executable], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return null;
  }
}
