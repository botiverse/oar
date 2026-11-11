import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";
import { codexInstalledExecutableCandidates } from "./installation-candidates.js";

export { codexInstalledExecutableCandidates, desktopBuildExecutables } from "./installation-candidates.js";

// OAR drives Codex through its app-server surface; a codex without it is unsupported.
export const codexInstallation = executableInstallation(
  "OAR_CODEX_BIN",
  "codex",
  (env) => codexInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  ["app-server", "--help"],
);
