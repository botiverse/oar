import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { dshInstallation } from "./installation.js";
import { dshInstall, dshInstallPlan } from "./install.js";
import { dshRefusedSessionOptions } from "./options.js";

export const dshRuntime = defineRuntime({
  id: "dsh", brand: runtimeBrands.dsh,
  refusedSessionOptions: dshRefusedSessionOptions,
  installation: dshInstallation, install: dshInstall, installPlan: dshInstallPlan,
  listModels: onFirstCall(async () => { const { dshListModels } = await import("./list-models.js"); return dshListModels; }),
  session: onFirstCall(async () => { const { dshSession } = await import("./session.js"); return dshSession; }),
}, { execution: "process" });
