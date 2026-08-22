import { defineRuntime } from "../../contracts/runtime.js";
import { codexAccountUsage } from "./account-usage.js";
import { codexInstallation } from "./installation.js";
import { codexSession } from "./session.js";

export const codexRuntime = defineRuntime({
  id: "codex",
  installation: codexInstallation,
  accountUsage: codexAccountUsage,
  session: codexSession,
});

export { codexAccountUsage, projectCodexUsage } from "./account-usage.js";
export { codexSession } from "./session.js";
