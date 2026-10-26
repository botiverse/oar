import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

export const qoderInstallation = executableInstallation("OAR_QODER_BIN", "qodercli", (env) => [path.join(environmentHome(env), ".local", "bin", "qodercli")]);
