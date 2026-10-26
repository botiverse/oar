import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";
import { qwenInstallPaths } from "./install-paths.js";

export const qwenInstallation = executableInstallation("OAR_QWEN_BIN", "qwen",
  (env) => process.platform === "win32" ? [] : [path.join(qwenInstallPaths(env).bin, "qwen")]);
