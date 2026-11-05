import type { InstallationProbe } from "../../contracts/installation.js";
import { executableInstallation } from "../../shared/installation.js";
import { dshVersionRefusal } from "./version.js";

const located = executableInstallation("OAR_DSH_BIN", "dsh");

/** `dsh` on PATH or `OAR_DSH_BIN`, with its real version at or above the floor. */
export const dshInstallation: InstallationProbe = async (options = {}) => {
  const snapshot = await located(options);
  if (snapshot.kind !== "available" || snapshot.via !== "executable") { return snapshot; }
  const refusal = dshVersionRefusal(snapshot.version);
  return refusal === null ? snapshot : { kind: "unsupported", reason: refusal };
};
