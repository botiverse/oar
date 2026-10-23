import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { qwenInstallation } from "./installation.js";
import { qwenInstallPaths } from "./install-paths.js";

/** Require the standalone archive and preserve shell profiles; the vendor verifies the archive's checksum. */
export const qwenInstallMethod: ScriptInstallMethod = {
  source: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
  line: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash -s -- --method standalone --no-modify-path",
  tools: ["curl", "bash"],
  writes: () => {
    const paths = qwenInstallPaths();
    return [paths.bin, path.dirname(paths.library)];
  },
  windows: "Follow the official PowerShell installer at https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
};

export const qwenInstallPlan = scriptInstallPlan(qwenInstallMethod);
export const qwenInstall = planInstaller(qwenInstallation, qwenInstallPlan);
