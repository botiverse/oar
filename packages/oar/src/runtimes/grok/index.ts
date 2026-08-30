import { defineRuntime } from "../../contracts/runtime.js";
import { grokAccountUsage } from "./account-usage.js";
import { grokInstallation } from "./installation.js";
import { grokSession } from "./session.js";

export const grokRuntime = defineRuntime({
  id: "grok",
  installation: grokInstallation,
  accountUsage: grokAccountUsage,
  session: grokSession,
});

export { grokAccountEmail, grokAccountUsage, projectGrokUsage } from "./account-usage.js";
export { grokSession } from "./session.js";
