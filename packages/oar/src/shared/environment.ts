import type { SessionOptions } from "../contracts/session.js";

/** A fresh child environment: strings override, null removes, and the host is untouched. */
export function sessionEnvironment(
  overlay: SessionOptions["env"],
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...inherited };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    // Windows environment names are case-insensitive. Remove every spelling
    // before setting, so Node's sorted-key selection cannot revive an alias.
    if (platform === "win32") {
      for (const name of Object.keys(environment)) {
        if (name.toUpperCase() === key.toUpperCase()) {
          delete environment[name];
        }
      }
    }
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}
