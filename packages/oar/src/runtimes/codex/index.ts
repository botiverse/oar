import { defineRuntime } from "../../contracts/runtime.js";
import { codexAccountUsage } from "./account-usage.js";
import { codexInstallation } from "./installation.js";
import { codexListModels } from "./list-models.js";
import { codexSession } from "./session.js";

export const codexRuntime = defineRuntime({
  id: "codex",
  installation: codexInstallation,
  accountUsage: codexAccountUsage,
  listModels: codexListModels,
  session: codexSession,
});

export { codexAccountUsage, projectCodexUsage } from "./account-usage.js";
export { codexListModels, projectCodexModels } from "./list-models.js";
export { codexSession } from "./session.js";
