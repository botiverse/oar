import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";

/** Native env flag that suppresses agy's detached `--bg-updater` child (literal `"true"` only). */
export const ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV = "AGY_CLI_DISABLE_AUTO_UPDATE";

function hasEnvironmentKey(
  env: Readonly<Record<string, string | null | undefined>> | undefined,
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env === undefined) { return false; }
  if (platform === "win32") {
    const target = name.toUpperCase();
    return Object.entries(env).some(([key, value]) => key.toUpperCase() === target && value !== undefined);
  }
  return Object.hasOwn(env, name) && env[name] !== undefined;
}

/**
 * Default `AGY_CLI_DISABLE_AUTO_UPDATE="true"` on non-update Antigravity spawns
 * unless the caller's overlay (including `null` removal) or inherited env
 * already specifies it, matching case-insensitively on Windows.
 */
export function antigravityEnvOverlay(
  overlay: SessionOptions["env"],
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): SessionOptions["env"] {
  if (
    hasEnvironmentKey(overlay, ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV, platform)
    || hasEnvironmentKey(inherited, ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV, platform)
  ) {
    return overlay;
  }
  return { ...overlay, [ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV]: "true" };
}

/** Resolve an Antigravity child environment with the native auto-updater disabled by default. */
export function antigravityEnvironment(
  overlay: SessionOptions["env"],
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return sessionEnvironment(antigravityEnvOverlay(overlay, inherited, platform), inherited, platform);
}
