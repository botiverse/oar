import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

export const codebuddyInstallation = executableInstallation("OAR_CODEBUDDY_BIN", "codebuddy", (env) => [
  path.join(environmentHome(env), ".local", "bin", process.platform === "win32" ? "codebuddy.exe" : "codebuddy"),
], ["--help"]);
