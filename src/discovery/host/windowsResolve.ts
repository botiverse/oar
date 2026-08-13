/**
 * Windows command resolution — port of raft daemon probe.ts
 * (merge Machine/User PATH, PowerShell Get-Command, .ps1 → .cmd/.bat/.exe).
 *
 * Refresh failure is a bounded fallback: no raw stderr/path/command leak.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type WindowsEnvironmentScopes = {
  machine?: NodeJS.ProcessEnv;
  user?: NodeJS.ProcessEnv;
};

export type WindowsEnvironmentReader = (
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
) => WindowsEnvironmentScopes | null;

export type CommandResolveDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFileSyncFn?: typeof execFileSync;
  existsSyncFn?: (filePath: string) => boolean;
  windowsEnvironmentReaderFn?: WindowsEnvironmentReader;
  /** Called with a closed, bounded code when Machine/User PATH refresh fails. */
  onRefreshFailed?: (code: "windows_env_refresh_failed") => void;
  /** `throw` = exec failures propagate (install candidate evidence). Default `null`. */
  failMode?: "null" | "throw";
};

export const WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS = 1000;

export function mergeWindowsPathSegments(values: Array<string | undefined>): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawSegment of value.split(";")) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const key = segment.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join(";") : undefined;
}

function findEnvKey(env: NodeJS.ProcessEnv | undefined, name: string): string | null {
  if (!env) return null;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowerName) return key;
  }
  return null;
}

function getEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const key = findEnvKey(env, name);
  return key ? env?.[key] : undefined;
}

export function mergeWindowsEnvironmentScopes(
  baseEnv: NodeJS.ProcessEnv,
  scopes: WindowsEnvironmentScopes,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  const pathValue = mergeWindowsPathSegments([
    getEnvValue(baseEnv, "Path"),
    getEnvValue(scopes.machine, "Path"),
    getEnvValue(scopes.user, "Path"),
  ]);
  const pathKey = findEnvKey(baseEnv, "Path") ?? findEnvKey(scopes.machine, "Path") ?? findEnvKey(scopes.user, "Path") ?? "Path";
  if (pathValue) merged[pathKey] = pathValue;
  return merged;
}

const WINDOWS_ENVIRONMENT_SCRIPT = [
  "& {",
  "  $result = [ordered]@{}",
  "  foreach ($scope in @('Machine', 'User')) {",
  "    $scopeEnv = [Environment]::GetEnvironmentVariables($scope)",
  "    $scopeObj = [ordered]@{}",
  "    foreach ($key in $scopeEnv.Keys) {",
  "      $value = $scopeEnv[$key]",
  "      if ($null -ne $value) { $scopeObj[$key] = [string]$value }",
  "    }",
  "    $result[$scope] = $scopeObj",
  "  }",
  "  $result | ConvertTo-Json -Compress -Depth 3",
  "}",
].join("\n");

function defaultWindowsEnvironmentReader(
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
): WindowsEnvironmentScopes | null {
  try {
    const output = String(
      execFileSyncFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENVIRONMENT_SCRIPT],
        { stdio: ["ignore", "pipe", "ignore"], env, timeout: 5000, encoding: "utf8" },
      ) ?? "",
    );
    const parsed = JSON.parse(output || "{}") as { Machine?: NodeJS.ProcessEnv; User?: NodeJS.ProcessEnv };
    return {
      ...(parsed.Machine ? { machine: parsed.Machine } : {}),
      ...(parsed.User ? { user: parsed.User } : {}),
    };
  } catch {
    return null;
  }
}

function resolveCommandOnWindows(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  existsSyncFn: (filePath: string) => boolean,
  failMode: "null" | "throw" = "null",
): string | null {
  const script =
    "& {$cmd = Get-Command -Name $args[0] -ErrorAction Stop | Select-Object -First 1; " +
    "if ($cmd.Path) { $cmd.Path } " +
    "elseif ($cmd.Source) { $cmd.Source } " +
    "elseif ($cmd.Definition) { $cmd.Definition } }";
  try {
    const output = String(
      execFileSyncFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script, command],
        { stdio: ["ignore", "pipe", "ignore"], env, timeout: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS, encoding: "utf8" },
      ) ?? "",
    );
    const resolved = output.trim().split(/\r?\n/)[0];
    if (!resolved) return null;
    if (resolved.toLowerCase().endsWith(".ps1")) {
      const dir = path.dirname(resolved);
      const base = path.basename(resolved, ".ps1");
      for (const alt of [
        path.join(dir, `${base}.cmd`),
        path.join(dir, `${base}.bat`),
        path.join(dir, `${base}.exe`),
        path.join(dir, base),
      ]) {
        if (existsSyncFn(alt)) return alt;
      }
      return null;
    }
    return resolved;
  } catch (error) {
    if (failMode === "throw") throw error;
    return null;
  }
}

/** Resolve a command on PATH. On win32: refresh PATH then Get-Command + .ps1 prefer. */
export function resolveCommandOnPath(command: string, deps: CommandResolveDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  let env = deps.env ?? process.env;
  if (platform === "win32") {
    const reader = deps.windowsEnvironmentReaderFn ?? defaultWindowsEnvironmentReader;
    const scopes = reader(env, execFileSyncFn);
    if (scopes) {
      env = mergeWindowsEnvironmentScopes(env, scopes);
    } else {
      deps.onRefreshFailed?.("windows_env_refresh_failed");
    }
    return resolveCommandOnWindows(
      command,
      env,
      execFileSyncFn,
      existsSyncFn,
      deps.failMode ?? "null",
    );
  }
  try {
    const output = String(
      execFileSyncFn("which", [command], {
        stdio: ["ignore", "pipe", "ignore"],
        env,
        encoding: "utf8",
      }) ?? "",
    );
    return output.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
