import type { InstallationProbe } from "../../contracts/installation.js";
import { executableInstallation } from "../../shared/installation.js";

/** `bottega` on PATH, or the one `OAR_BOTTEGA_BIN` pins: a launcher that runs it elsewhere (a container) is pinned the same way. */
export const bottegaInstallation: InstallationProbe = executableInstallation("OAR_BOTTEGA_BIN", "bottega");
