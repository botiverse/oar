import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { factoryInstallation } from "./installation.js";
import { factoryInstall, factoryInstallPlan } from "./install.js";
import { factoryRefusedSessionOptions } from "./options.js";

/** Factory's droid CLI over its native stream-jsonrpc; sign-in through droid's own ACP entry (docs/runtimes/factory.md). */
export const factoryRuntime = defineRuntime({
  id: "factory",
  sessionCapabilities: () => ({ steer: true, images: true, contextUsage: { tokens: true, contextWindow: true }, mcpTransports: ["stdio", "http"], stopTask: false }), brand: runtimeBrands.factory, verifiedPlatforms: verifiedPlatforms.factory,
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: factoryRefusedSessionOptions,
  installation: factoryInstallation, install: factoryInstall, installPlan: factoryInstallPlan,
  checkUpdate: onFirstCall(async () => { const { factoryCheckUpdate } = await import("./update.js"); return factoryCheckUpdate; }),
  upgrade: onFirstCall(async () => { const { factoryUpgrade } = await import("./update.js"); return factoryUpgrade; }),
  login: onFirstCall(async () => { const { factoryLogin } = await import("./account.js"); return factoryLogin; }),
  logout: onFirstCall(async () => { const { factoryLogout } = await import("./account.js"); return factoryLogout; }),
  authStatus: onFirstCall(async () => { const { factoryAuthStatus } = await import("./account.js"); return factoryAuthStatus; }),
  accountUsage: onFirstCall(async () => { const { factoryAccountUsage } = await import("./account-usage.js"); return factoryAccountUsage; }),
  listModels: onFirstCall(async () => { const { factoryListModels } = await import("./list-models.js"); return factoryListModels; }),
  skills: onFirstCall(async () => { const { factorySkills } = await import("./skills.js"); return factorySkills; }),
  session: onFirstCall(async () => { const { factorySession } = await import("./session.js"); return factorySession; }),
}, { execution: "process" });
