import type { SessionOptions } from "../../contracts/session.js";
import type { AcpSessionProfile } from "./profile.js";

/** The agent's argv for a session: the profile's args, with the host's own (SessionOptions.launchArgs) where the profile places them, after by default. */
export function acpLaunchArgs(profile: Pick<AcpSessionProfile, "args" | "withLaunchArgs">, options: SessionOptions): readonly string[] {
  const args = typeof profile.args === "function" ? profile.args(options) : profile.args;
  const launchArgs = options.launchArgs ?? [];
  return launchArgs.length === 0 ? args : (profile.withLaunchArgs?.(args, launchArgs) ?? [...args, ...launchArgs]);
}
