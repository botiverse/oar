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
  // mcpTransports is omitted until HTTP MCP tool invocation is verified (factory.vendor.test.ts covers stdio only).
  sessionCapabilities: () => ({ steer: true, images: true, contextUsage: { tokens: true, contextWindow: true }, stopTask: false }), brand: runtimeBrands.factory, verifiedPlatforms: verifiedPlatforms.factory,
  // droid 1.12.1: FACTORY_API_KEY first, then OS keyring (auth.v2.keyring / auth.v2.loginkeychain) or keyfile (auth.v2.file + auth.v2.key) under $FACTORY_HOME_OVERRIDE/.factory.
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    usageDirectoryEnv: "FACTORY_HOME_OVERRIDE",
    env: [
      { name: "FACTORY_API_KEY", purpose: "api_key", secret: true, provider: "factory", field: "apiKey" },
      { name: "FACTORY_API_BASE_URL", purpose: "base_url", secret: false, provider: "factory", field: "baseUrl" },
      { name: "FACTORY_API_BASE_URL_EU", purpose: "base_url", secret: false, provider: "factory", field: "baseUrl" },
      { name: "FACTORY_DISABLE_KEYRING", purpose: "credential_source", secret: false, provider: "factory", field: "credentialSource" },
    ],
    stores: [
      { kind: "keychain", directoryEnv: "FACTORY_HOME_OVERRIDE", defaultDirectory: ".", overridesEnv: false },
      { kind: "file", directoryEnv: "FACTORY_HOME_OVERRIDE", defaultDirectory: ".", path: ".factory/auth.v2.file", overridesEnv: false },
      { kind: "file", directoryEnv: "FACTORY_HOME_OVERRIDE", defaultDirectory: ".", path: ".factory/auth.v2.key", overridesEnv: false },
      { kind: "file", directoryEnv: "FACTORY_HOME_OVERRIDE", defaultDirectory: ".", path: ".factory/settings.json" },
    ],
  },
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
