import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions } from "./options.js";
import { opencodeSharedRefusal } from "./sharing-admission.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  brand: runtimeBrands.opencode,
  refusedSessionOptions: opencodeRefusedSessionOptions,
  mcpToolsListChanged: "full",
  installation: opencodeInstallation,
  installPlan: opencodeInstallPlan,
  install: opencodeInstall,
  installLines: opencodeInstallLines,
  session: onFirstCall(async () => {
    const { opencodeSession } = await import("./session.js");
    return opencodeSession;
  }),
  listModels: opencodeListModels,
}, { execution: "process", shared: {
  refusal: opencodeSharedRefusal,
  session: () => onFirstCall(async () => {
    const { createOpenCodeSharedSession } = await import("./shared-session.js");
    return createOpenCodeSharedSession();
  }),
} });
