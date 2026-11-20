/* oxlint-disable import/max-dependencies -- The runtime declaration imports one module per capability. */
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { codexSkills, codexMcpServers, codexTools } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { extractSemver, semverAtLeast } from "../../shared/semver.js";
import { codexAuthStatus, codexLogin } from "./login.js";
import { codexLogout } from "./logout.js";
import { codexAccountUsage } from "./account-usage.js";
import { codexRedeemLimitReset } from "./limit-reset.js";
import { codexInstallation } from "./installation.js";
import { codexInstall, codexInstallPlan } from "./install.js";
import { codexListModels } from "./list-models.js";
import { codexCheckUpdate, codexUpgrade } from "./update.js";
import { codexRefusedSessionOptions } from "./options.js";
import { codexSession } from "./session.js";

export const codexRuntime = defineRuntime({
  id: "codex",
  sessionCapabilities: (installation) => ({
    steer: true, images: true, mcpTransports: ["stdio", "http"], stopTask: true,
    mcpStartup: installation.via === "executable" && ["0.169.0", "0.170.0"].includes(extractSemver(installation.version) ?? "")
      ? { kind: "per_server", firstModelRequest: "may_start_pending" } : { kind: "unknown" },
    ...(installation.via === "executable" && semverAtLeast(installation.version, "0.160.1") ? { fileChanges: true } : {}),
    ...(installation.via === "executable" && semverAtLeast(installation.version, "0.169.0") ? { nativeSessionFile: true } : {}),
    ...(installation.via === "executable" && semverAtLeast(installation.version, "0.151.0") ? { contextUsage: { tokens: true, contextWindow: true } } : {}),
  }),
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: codexRefusedSessionOptions,
  resumedSessionOptions: {
    systemPrompt: { provided: "immediate", omitted: "saved" },
    appendSystemPrompt: { provided: "next_compaction", omitted: "saved_until_compaction" },
  },
  brand: runtimeBrands.codex, verifiedPlatforms: verifiedPlatforms.codex,
  // Codex 0.170.0: keyring service "Codex Auth" (login/src/auth/storage.rs:396) and $CODEX_HOME/auth.json + config.toml.
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    usageDirectoryEnv: "CODEX_HOME",
    env: [
      { name: "OPENAI_API_KEY", purpose: "api_key", secret: true, provider: "openai", field: "apiKey" },
      { name: "CODEX_API_KEY", purpose: "api_key", secret: true, provider: "openai", field: "apiKey" },
      { name: "CODEX_ACCESS_TOKEN", purpose: "token", secret: true, provider: "openai", field: "authToken" },
      { name: "OPENAI_BASE_URL", purpose: "base_url", secret: false, provider: "openai", field: "baseUrl" },
    ],
    stores: [
      { kind: "keychain", directoryEnv: "CODEX_HOME", defaultDirectory: ".codex", service: "Codex Auth" },
      { kind: "file", directoryEnv: "CODEX_HOME", defaultDirectory: ".codex", path: "auth.json" },
      { kind: "file", directoryEnv: "CODEX_HOME", defaultDirectory: ".codex", path: "config.toml" },
    ],
  },
  skills: codexSkills,
  mcpServers: codexMcpServers,
  tools: codexTools,
  mcpToolsListChanged: "none",
  installation: codexInstallation,
  installPlan: codexInstallPlan,
  install: codexInstall,
  accountUsage: codexAccountUsage,
  redeemLimitReset: codexRedeemLimitReset,
  listModels: codexListModels,
  checkUpdate: codexCheckUpdate,
  upgrade: codexUpgrade,
  login: codexLogin,
  logout: codexLogout,
  authStatus: codexAuthStatus,
  session: codexSession,
}, { execution: "process" });
