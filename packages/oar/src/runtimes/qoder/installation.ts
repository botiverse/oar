import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

export const qoderInstallation = executableInstallation("OAR_QODER_BIN", "qodercli", [path.join(homedir(), ".local", "bin", "qodercli")]);
