/**
 * Small CLI helpers for host-side runtime detection.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(locator, [cmd], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Raw command runner seam. Returns the uninterpreted result; callers derive meaning.
 * Injectable so tests can supply command RESULTS without spawning; production stays `runText`.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => { ok: boolean; stdout: string; stderr: string; code: number | null };

export function runText(
  command: string,
  args: readonly string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    code: r.status,
  };
}

export function firstLineVersion(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("Warning:"));
  return line ?? null;
}

export function home(...parts: string[]): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ...parts);
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
