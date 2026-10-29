import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { antigravityInstallation } from "./installation.js";
import { antigravityInstall, antigravityInstallPlan } from "./install.js";
import { antigravityCheckUpdate } from "./update.js";
import { antigravityRefusedSessionOptions } from "./options.js";

export const antigravityRuntime = defineRuntime({
  id: "antigravity",
  brand: runtimeBrands.antigravity,
  installation: antigravityInstallation,
  installPlan: antigravityInstallPlan,
  install: antigravityInstall,
  session: onFirstCall(async () => {
    const { antigravitySession } = await import("./session.js");
    return antigravitySession;
  }),
  listModels: onFirstCall(async () => {
    const { antigravityListModels } = await import("./list-models.js");
    return antigravityListModels;
  }),
  checkUpdate: antigravityCheckUpdate,
  refusedSessionOptions: antigravityRefusedSessionOptions,
  mcpToolsListChanged: "full",
}, { execution: "process" });
