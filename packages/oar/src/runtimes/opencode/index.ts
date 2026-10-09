import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions, opencodeSession } from "./session.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  brand: runtimeBrands.opencode,
  refusedSessionOptions: opencodeRefusedSessionOptions,
  installation: opencodeInstallation,
  installPlan: opencodeInstallPlan,
  install: opencodeInstall,
  installLines: opencodeInstallLines,
  session: opencodeSession,
  listModels: opencodeListModels,
});

export { opencodeSession } from "./session.js";
