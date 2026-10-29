import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import type { InstallationProbe } from "../../contracts/installation.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { resolveExecutable } from "../../shared/executable/index.js";
import { npmGlobalBin, npmGlobalPrefix } from "../../shared/install-npm.js";
import { executableInstallation } from "../../shared/installation.js";

const directInstallation = executableInstallation("OAR_CODEBUDDY_BIN", "codebuddy", (env) => [
  path.join(environmentHome(env), ".local", "bin", process.platform === "win32" ? "codebuddy.exe" : "codebuddy"),
], ["--help"]);

/** A configured override remains exclusive. Only an otherwise missing copy triggers npm's local prefix lookup. */
export const codebuddyInstallation: InstallationProbe = async (options = {}) => {
  const direct = await directInstallation(options);
  const env = sessionEnvironment(options.env);
  const pinned = environmentValue(env, "OAR_CODEBUDDY_BIN");
  if (direct.kind !== "not_found" || (pinned !== undefined && pinned !== "")) { return direct; }
  const npm = resolveExecutable("npm", env);
  if (npm === null) { return direct; }
  const prefix = await npmGlobalPrefix(npm, env).catch((): null => null);
  if (prefix === null) { return direct; }
  const command = path.join(npmGlobalBin(prefix), process.platform === "win32" ? "codebuddy.cmd" : "codebuddy");
  return executableInstallation("OAR_CODEBUDDY_BIN", "codebuddy", [command], ["--help"])(options);
};
