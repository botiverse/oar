import { runtimeBrands } from "../../brands.js";
import { grokSkills, grokMcpServers } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { grokInstallation } from "./installation.js";
import { grokInstall, grokInstallPlan } from "./install.js";
import { grokCheckUpdate, grokUpgrade } from "./update.js";
import { grokRefusedSessionOptions } from "./options.js";

export const grokRuntime = defineRuntime({
  id: "grok",
  brand: runtimeBrands.grok,
  refusedSessionOptions: grokRefusedSessionOptions,
  mcpToolsListChanged: "none",
  skills: grokSkills,
  mcpServers: grokMcpServers,

  installation: grokInstallation,
  installPlan: grokInstallPlan,
  install: grokInstall,
  accountUsage: onFirstCall(async () => {
    const { grokAccountUsage } = await import("./account-usage.js");
    return grokAccountUsage;
  }),
  listModels: onFirstCall(async () => {
    const { grokListModels } = await import("./list-models.js");
    return grokListModels;
  }),
  checkUpdate: grokCheckUpdate,
  upgrade: grokUpgrade,
  session: onFirstCall(async () => {
    const { grokSession } = await import("./session.js");
    return grokSession;
  }),
});
