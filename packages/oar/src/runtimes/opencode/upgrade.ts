import type { Upgrader } from "../../contracts/update.js";
import { runNativeUpgrade } from "../../shared/update.js";
import { opencodeRelease } from "./version.js";

/** Pin the release line to what the selected executable reports just before mutation. */
export const opencodeUpgrade: Upgrader = async (installation, options) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation", detail: "OpenCode upgrade requires an executable" };
  }
  const { command } = installation;
  try {
    const release = await opencodeRelease({ kind: "available", via: "executable", command });
    if (release.major !== 2) {
      return { kind: "unsupported", reason: "unsupported_installation", detail: "OAR drives the native upgrade only on the OpenCode v2 release line" };
    }
    const result = await runNativeUpgrade(command, release.version, { args: ["upgrade"] }, options);
    return result;
  } catch (error) {
    return { kind: "failed", exitCode: null, output: String(error) };
  }
};
