import { runtimeBrands } from "../../brands.js";
import { grokSkills, grokMcpServers } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { grokAccountUsage } from "./account-usage.js";
import { grokInstallation } from "./installation.js";
import { grokListModels } from "./list-models.js";
import { grokCheckUpdate, grokUpgrade } from "./update.js";
import { grokRefusedSessionOptions, grokSession } from "./session.js";

export const grokRuntime = defineRuntime({
  id: "grok",
  brand: runtimeBrands.grok,
  skills: grokSkills,
  mcpServers: grokMcpServers,

  installation: grokInstallation,
  accountUsage: grokAccountUsage,
  listModels: grokListModels,
  checkUpdate: grokCheckUpdate,
  upgrade: grokUpgrade,
  refusedSessionOptions: grokRefusedSessionOptions,
  session: grokSession,
});

export { grokAccountEmail, grokAccountUsage, projectGrokUsage } from "./account-usage.js";
export { grokListModels, projectGrokModels } from "./list-models.js";
export { grokSession } from "./session.js";
