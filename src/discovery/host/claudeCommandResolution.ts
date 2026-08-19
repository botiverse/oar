/**
 * Claude Code binary resolution — shared by detect (and future usage/drive).
 *
 * Faithful to raft daemon `resolveClaudeCommand`
 * (repos/slock/packages/daemon/src/drivers/claudeLaunch.ts): PATH first, then on
 * macOS the "Claude Code URL Handler.app" desktop bundle. oar previously used
 * PATH-only `which("claude")`, so a desktop-installed claude that is not on PATH
 * was invisible.
 *
 * Deliberately unlike codex: raft has **no** `CLAUDE_BIN` env override, no
 * app-server probe, and no version arbitration for claude (its model catalog is
 * static). Porting those here would invent capability raft does not have, so this
 * stays a two-step PATH → desktop-bundle resolve.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { which } from "../cli.js";

/** `~/Applications/...` relative segment for the desktop-installed Claude Code CLI. */
export const CLAUDE_DESKTOP_CLI_RELATIVE_PATH = path.join(
  "Applications",
  "Claude Code URL Handler.app",
  "Contents",
  "MacOS",
  "claude",
);
/** System `/Applications/...` desktop-installed Claude Code CLI. */
export const CLAUDE_DESKTOP_CLI_SYSTEM_PATH =
  "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude";

export type ClaudeResolveDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  which?: (cmd: string, env?: NodeJS.ProcessEnv) => string | null;
  exists?: (p: string) => boolean;
};

/** Resolve the Claude Code binary: PATH → (darwin only) desktop bundle. */
export function resolveClaudeCommand(deps: ClaudeResolveDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const whichFn = deps.which ?? which;
  const onPath = whichFn("claude", env);
  if (onPath) return onPath;

  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return null;

  const exists = deps.exists ?? existsSync;
  const homeDir = deps.homeDir ?? env.HOME ?? env.USERPROFILE ?? "";
  const candidates = [
    homeDir ? path.join(homeDir, CLAUDE_DESKTOP_CLI_RELATIVE_PATH) : null,
    CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
