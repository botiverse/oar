import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { antigravityInstallation } from "./installation.js";
import { antigravityInstall, antigravityInstallPlan } from "./install.js";
import { antigravityCheckUpdate } from "./update.js";
import { antigravityRefusedSessionOptions } from "./options.js";
import { antigravityAuthStatus, antigravityLogin } from "./auth.js";

export const antigravityRuntime = defineRuntime({
  id: "antigravity",
  manualCompaction: { kind: "unsupported", reason: "The CLI advertises /compact, but no structured completion and attribution contract has been verified." },
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
  login: antigravityLogin,
  logout: onFirstCall(async () => { const { antigravityLogout } = await import("./logout.js"); return antigravityLogout; }),
  authStatus: antigravityAuthStatus,
  refusedSessionOptions: antigravityRefusedSessionOptions,
  mcpToolsListChanged: "none",
}, { execution: "process" });
