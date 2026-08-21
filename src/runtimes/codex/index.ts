import { defineRuntime } from "../../contracts/runtime.js";
import { createCodexAccountUsage } from "./account-usage.js";
import { createCodexInstallation } from "./installation.js";

export const codexRuntime = defineRuntime({
  id: "codex",
  installation: createCodexInstallation(),
  accountUsage: createCodexAccountUsage(),
});

export { createCodexAccountUsage, projectCodexUsage } from "./account-usage.js";
export { createCodexInstallation } from "./installation.js";
