import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";
import { qwenInstallPaths } from "./install-paths.js";

/** Verify Qwen Code identity on `--help` (measured on 0.26.0: `Usage: qwen ... Qwen Code`). */
export const qwenInstallation = executableInstallation(
  "OAR_QWEN_BIN",
  "qwen",
  (env) => process.platform === "win32" ? [] : [path.join(qwenInstallPaths(env).bin, "qwen")],
  ["--help"],
  { identity: { vendor: "Qwen Code", help: /\bUsage:\s+qwen(?:\.exe)?\b|\bQwen Code\b/iu } },
);
