import { defineRuntime } from "../../contracts/runtime.js";
import { codexAccountUsage } from "./account-usage.js";
import { codexInstallation } from "./installation.js";

export const codexRuntime = defineRuntime({
  id: "codex",
  installation: codexInstallation,
  accountUsage: codexAccountUsage,
});

export { codexAccountUsage, projectCodexUsage } from "./account-usage.js";
