// BYOK change: Modified from OAR 95c6547 for SDK-owned processes and explicit environments (Apache-2.0).
import type { ExecutableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";

/** The two independently maintained native lines share one command name. */
export async function opencodeMajor(installation: ExecutableInstallation, options?: Pick<SessionOptions, "cwd" | "env">): Promise<1 | 2> {
  // BYOK: the SDK probes once using its selected executable and process boundary.
  const version = installation.version;
  if (version === undefined) throw new Error("opencode requires a probed executable version");
  const major = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:\S*)$/u.exec(version.trim())?.[1];
  if (major === "1" || major === "2") { return major === "1" ? 1 : 2; }
  throw new Error(`Unrecognized opencode release line: ${JSON.stringify(version)}`);
}
