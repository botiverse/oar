import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { dshInstallation } from "./installation.js";
import { dshInstall, dshInstallPlan } from "./install.js";
import { dshRefusedSessionOptions } from "./options.js";
import { DSH_MINIMUM_VERSION } from "./version.js";

export const dshRuntime = defineRuntime({
  id: "dsh", brand: runtimeBrands.dsh,
  minVersion: DSH_MINIMUM_VERSION,
  refusedSessionOptions: dshRefusedSessionOptions,
  installation: dshInstallation, install: dshInstall, installPlan: dshInstallPlan,
  listModels: onFirstCall(async () => { const { dshListModels } = await import("./list-models.js"); return dshListModels; }),
  session: onFirstCall(async () => { const { dshSession } = await import("./session.js"); return dshSession; }),
}, { execution: "process" });
