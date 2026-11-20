import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { semverAtLeast } from "../../shared/semver.js";
import { kimiAccountUsage } from "./account-usage.js";
import { kimiInstallation } from "./installation.js";
import { kimiInstall, kimiInstallPlan } from "./install.js";
import { kimiCheckUpdate, kimiUpgrade } from "./update.js";
import { kimiRefusedSessionOptions } from "./options.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  sessionCapabilities: (installation) => ({
    steer: false, stopTask: false, contextUsage: { tokens: true, contextWindow: true },
    // 2.1.1: oldest version observed advertising mcpCapabilities.http and tested calling stdio/HTTP echo tools in mcp-servers-acp.vendor.test.ts.
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.1.1") ? { mcpTransports: ["stdio", "http"] as const } : {}),
  }),
  manualCompaction: { kind: "unsupported", reason: "The ACP transport reports compaction as ordinary text, without a structural completion signal." },
  brand: runtimeBrands.kimi, verifiedPlatforms: verifiedPlatforms.kimi,
  // Kimi 2.6.3: $KIMI_CODE_HOME (default ~/.kimi-code) credentials/ and config.toml; model and endpoint env overrides (docs/runtimes/kimi.md).
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    usageDirectoryEnv: "KIMI_CODE_HOME",
    env: [
      { name: "KIMI_MODEL_API_KEY", purpose: "api_key", secret: true, provider: "kimi", field: "apiKey" },
      { name: "KIMI_MODEL_BASE_URL", purpose: "base_url", secret: false, provider: "kimi", field: "baseUrl" },
      { name: "KIMI_MODEL_NAME", purpose: "model_route", secret: false, provider: "kimi", field: "model" },
      { name: "KIMI_CODE_BASE_URL", purpose: "base_url", secret: false, provider: "kimi", field: "baseUrl" },
      { name: "KIMI_CODE_OAUTH_HOST", purpose: "base_url", secret: false, provider: "kimi", field: "baseUrl" },
      { name: "KIMI_OAUTH_HOST", purpose: "base_url", secret: false, provider: "kimi", field: "baseUrl" },
    ],
    stores: [
      { kind: "dir", directoryEnv: "KIMI_CODE_HOME", defaultDirectory: ".kimi-code", path: "credentials" },
      { kind: "file", directoryEnv: "KIMI_CODE_HOME", defaultDirectory: ".kimi-code", path: "config.toml" },
    ],
  },
  installation: kimiInstallation,
  installPlan: kimiInstallPlan,
  install: kimiInstall,
  accountUsage: kimiAccountUsage,
  login: onFirstCall(async () => { const { kimiLogin } = await import("./login.js"); return kimiLogin; }),
  authStatus: onFirstCall(async () => { const { kimiAuthStatus } = await import("./auth-status.js"); return kimiAuthStatus; }),
  logout: onFirstCall(async () => { const { kimiLogout } = await import("./logout.js"); return kimiLogout; }),
  listModels: onFirstCall(async () => {
    const { kimiListModels } = await import("./list-models.js");
    return kimiListModels;
  }),
  skills: onFirstCall(async () => { const { kimiSkills } = await import("./skills.js"); return kimiSkills; }),
  checkUpdate: kimiCheckUpdate,
  upgrade: kimiUpgrade,
  session: onFirstCall(async () => {
    const { kimiSession } = await import("./session.js");
    return kimiSession;
  }),
  refusedSessionOptions: kimiRefusedSessionOptions,
  mcpToolsListChanged: "none",
}, { execution: "process" });

export type { KimiLoginOptions } from "./login.js";
