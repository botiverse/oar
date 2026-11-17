import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { devinAuthStatus } from "./auth.js";
import { devinInstall, devinInstallPlan } from "./install.js";
import { devinInstallation } from "./installation.js";
import { devinRefusedSessionOptions } from "./options.js";
import { devinCheckUpdate } from "./update.js";

export const devinRuntime = defineRuntime({
  id: "devin",
  sessionCapabilities: () => ({ steer: false }),
  manualCompaction: { kind: "unsupported", reason: "Devin CLI ACP exposes no verified manual compaction protocol or structured completion signal." },
  brand: runtimeBrands.devin,
  installation: devinInstallation,
  installPlan: devinInstallPlan,
  install: devinInstall,
  session: onFirstCall(async () => {
    const { devinSession } = await import("./session.js");
    return devinSession;
  }),
  listModels: onFirstCall(async () => {
    const { devinListModels } = await import("./list-models.js");
    return devinListModels;
  }),
  skills: onFirstCall(async () => { const { devinSkills } = await import("./skills.js"); return devinSkills; }),
  checkUpdate: devinCheckUpdate,
  authStatus: devinAuthStatus,
  refusedSessionOptions: devinRefusedSessionOptions,
}, { execution: "process" });
