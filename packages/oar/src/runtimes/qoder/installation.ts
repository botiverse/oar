import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";
import { versionAtLeast } from "../../shared/update.js";
import type { InstallationProbe } from "../../contracts/installation.js";

/** First verified worker release with the get_settings readback required on open. */
export const QODER_MINIMUM_VERSION = "1.1.78";

const probeExecutable = executableInstallation("OAR_QODER_BIN", "qodercli", (env) => [path.join(environmentHome(env), ".local", "bin", "qodercli")]);

export const qoderInstallation: InstallationProbe = async options => {
  const snapshot = await probeExecutable(options);
  if (snapshot.kind !== "available" || snapshot.via !== "executable") { return snapshot; }
  const { version } = snapshot;
  if (version !== undefined && /^\d+\.\d+\.\d+$/u.test(version) && versionAtLeast(version, QODER_MINIMUM_VERSION)) { return snapshot; }
  return {
    kind: "unsupported", code: "version_unsupported", via: "executable", command: snapshot.command,
    reason: `Qoder requires a stable CLI ${QODER_MINIMUM_VERSION} or newer; this installation reports ${version ?? "an unrecognized version"}`,
    ...(version === undefined ? {} : { installedVersion: version }), requiredVersion: QODER_MINIMUM_VERSION,
  };
};
