import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { factoryInstallation } from "./installation.js";
import { factoryInstall, factoryInstallPlan } from "./install.js";
import { factoryRefusedSessionOptions } from "./options.js";

/** Factory's droid CLI over its native stream-jsonrpc; sign-in through droid's own ACP entry (docs/runtimes/factory.md). */
export const factoryRuntime = defineRuntime({
  id: "factory", brand: runtimeBrands.factory,
  refusedSessionOptions: factoryRefusedSessionOptions,
  installation: factoryInstallation, install: factoryInstall, installPlan: factoryInstallPlan,
  checkUpdate: onFirstCall(async () => { const { factoryCheckUpdate } = await import("./update.js"); return factoryCheckUpdate; }),
  upgrade: onFirstCall(async () => { const { factoryUpgrade } = await import("./update.js"); return factoryUpgrade; }),
  login: onFirstCall(async () => { const { factoryLogin } = await import("./account.js"); return factoryLogin; }),
  logout: onFirstCall(async () => { const { factoryLogout } = await import("./account.js"); return factoryLogout; }),
  authStatus: onFirstCall(async () => { const { factoryAuthStatus } = await import("./account.js"); return factoryAuthStatus; }),
  listModels: onFirstCall(async () => { const { factoryListModels } = await import("./list-models.js"); return factoryListModels; }),
  session: onFirstCall(async () => { const { factorySession } = await import("./session.js"); return factorySession; }),
}, { execution: "process" });
