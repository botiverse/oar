import { defineRuntime } from "../../contracts/runtime.js";
import { grokAccountUsage } from "./account-usage.js";
import { grokInstallation } from "./installation.js";
import { grokListModels } from "./list-models.js";
import { grokSession } from "./session.js";

export const grokRuntime = defineRuntime({
  id: "grok",
  installation: grokInstallation,
  accountUsage: grokAccountUsage,
  listModels: grokListModels,
  session: grokSession,
});

export { grokAccountEmail, grokAccountUsage, projectGrokUsage } from "./account-usage.js";
export { grokListModels, projectGrokModels } from "./list-models.js";
export { grokSession } from "./session.js";
