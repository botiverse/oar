import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { kimiAccountUsage } from "./account-usage.js";
import { kimiInstallation } from "./installation.js";
import { kimiInstall, kimiInstallPlan } from "./install.js";
import { kimiCheckUpdate, kimiUpgrade } from "./update.js";
import { kimiRefusedSessionOptions } from "./options.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  brand: runtimeBrands.kimi,
  installation: kimiInstallation,
  installPlan: kimiInstallPlan,
  install: kimiInstall,
  accountUsage: kimiAccountUsage,
  listModels: onFirstCall(async () => {
    const { kimiListModels } = await import("./list-models.js");
    return kimiListModels;
  }),
  checkUpdate: kimiCheckUpdate,
  upgrade: kimiUpgrade,
  session: onFirstCall(async () => {
    const { kimiSession } = await import("./session.js");
    return kimiSession;
  }),
  refusedSessionOptions: kimiRefusedSessionOptions,
  mcpToolsListChanged: "none",
});

export { kimiAccountUsage, projectKimiUsage } from "./account-usage.js";
export { kimiAccountDisplayName, kimiAccountEmail } from "./profile.js";
