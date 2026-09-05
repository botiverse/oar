import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInstallation } from "./installation.js";
import { claudeListModels } from "./list-models.js";
import { claudeSession } from "./session.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  installation: claudeInstallation,
  accountUsage: claudeAccountUsage,
  listModels: claudeListModels,
  session: claudeSession,
});

export { claudeAccountUsage } from "./account-usage.js";
export { claudeListModels, projectClaudeModels } from "./list-models.js";
export { claudeSession } from "./session.js";
