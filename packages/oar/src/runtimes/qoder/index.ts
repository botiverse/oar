import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { qoderInstallation } from "./installation.js";
import { qoderInstall, qoderInstallPlan } from "./install.js";
import { qoderRefusedSessionOptions } from "./options.js";

export const qoderRuntime = defineRuntime({
  id: "qoder", brand: runtimeBrands.qoder,
  refusedSessionOptions: qoderRefusedSessionOptions,
  installation: qoderInstallation, install: qoderInstall, installPlan: qoderInstallPlan,
  login: onFirstCall(async () => { const { qoderLogin } = await import("./login.js"); return qoderLogin; }),
  authStatus: onFirstCall(async () => { const { qoderAuthStatus } = await import("./auth-status.js"); return qoderAuthStatus; }),
  listModels: onFirstCall(async () => { const { qoderListModels } = await import("./list-models.js"); return qoderListModels; }),
  session: onFirstCall(async () => { const { qoderSession } = await import("./session.js"); return qoderSession; }),
}, { execution: "process" });
