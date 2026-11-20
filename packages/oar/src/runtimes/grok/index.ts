import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { grokSkills, grokMcpServers } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { grokInstallation } from "./installation.js";
import { grokInstall, grokInstallPlan } from "./install.js";
import { grokCheckUpdate, grokUpgrade } from "./update.js";
import { grokSharedRefusal } from "./sharing-admission.js";
import { grokRefusedSessionOptions, grokSessionCapabilities } from "./options.js";

export const grokRuntime = defineRuntime({
  id: "grok",
  sessionCapabilities: grokSessionCapabilities,
  brand: runtimeBrands.grok, verifiedPlatforms: verifiedPlatforms.grok,
  // Grok 1.0.89: $GROK_HOME/auth.json (overrides XAI_API_KEY when present), mcp_credentials.json, config.toml; XAI_API_KEY fallback.
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    usageDirectoryEnv: "GROK_HOME",
    env: [{ name: "XAI_API_KEY", purpose: "api_key", secret: true, provider: "xai", field: "apiKey" }],
    stores: [
      { kind: "file", directoryEnv: "GROK_HOME", defaultDirectory: ".grok", path: "auth.json", overridesEnv: true },
      { kind: "file", directoryEnv: "GROK_HOME", defaultDirectory: ".grok", path: "mcp_credentials.json" },
      { kind: "file", directoryEnv: "GROK_HOME", defaultDirectory: ".grok", path: "config.toml" },
    ],
  },
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: grokRefusedSessionOptions,
  mcpToolsListChanged: "none",
  skills: grokSkills,
  mcpServers: grokMcpServers,

  installation: grokInstallation,
  installPlan: grokInstallPlan,
  install: grokInstall,
  accountUsage: onFirstCall(async () => {
    const { grokAccountUsage } = await import("./account-usage.js");
    return grokAccountUsage;
  }),
  listModels: onFirstCall(async () => {
    const { grokListModels } = await import("./list-models.js");
    return grokListModels;
  }),
  checkUpdate: grokCheckUpdate,
  upgrade: grokUpgrade,
  login: onFirstCall(async () => { const { grokLogin } = await import("./auth.js"); return grokLogin; }),
  authStatus: onFirstCall(async () => { const { grokAuthStatus } = await import("./auth.js"); return grokAuthStatus; }),
  logout: onFirstCall(async () => { const { grokLogout } = await import("./auth.js"); return grokLogout; }),
  session: onFirstCall(async () => {
    const { grokSession } = await import("./session.js");
    return grokSession;
  }),
}, { execution: "process", shared: { refusal: grokSharedRefusal, session: () => onFirstCall(async () => {
  const { createGrokSharedSession } = await import("./shared-session.js");
  return createGrokSharedSession();
}) } });
