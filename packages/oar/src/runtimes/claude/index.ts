import { claudeRefusedSessionOptions } from "./options.js";
/* oxlint-disable import/max-dependencies -- The runtime declaration imports one module per capability. */
import { runtimeBrands } from "../../brands.js";
import { claudeCommands, claudeSkills, claudeMcpServers, claudeTools } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAuthStatus, claudeLogin } from "./login.js";
import { claudeLogout } from "./logout.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInspectLimitResets, claudeRedeemLimitReset } from "./limit-reset/index.js";
import { claudeInstallation } from "./installation.js";
import { claudeInstall, claudeInstallPlan } from "./install.js";
import { claudeListModels } from "./list-models.js";
import { claudeCheckUpdate, claudeUpgrade } from "./update.js";
import { claudeSession } from "./session.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: claudeRefusedSessionOptions,
  resumedSessionOptions: {
    systemPrompt: { provided: "next_compaction", omitted: "saved_until_compaction" },
    appendSystemPrompt: { provided: "next_compaction", omitted: "saved_until_compaction" },
  },
  brand: runtimeBrands.claude,
  skills: claudeSkills,
  commands: claudeCommands,
  mcpServers: claudeMcpServers,
  tools: claudeTools,
  mcpToolsListChanged: "additions",

  installation: claudeInstallation,
  installPlan: claudeInstallPlan,
  install: claudeInstall,
  accountUsage: claudeAccountUsage,
  inspectLimitResets: claudeInspectLimitResets,
  redeemLimitReset: claudeRedeemLimitReset,
  listModels: claudeListModels,
  checkUpdate: claudeCheckUpdate,
  upgrade: claudeUpgrade,
  login: claudeLogin,
  logout: claudeLogout,
  authStatus: claudeAuthStatus,
  session: claudeSession,
}, { execution: "process" });

export { claudeAccountUsage } from "./account-usage.js";
export { claudeListModels, projectClaudeModels } from "./list-models.js";
export { claudeSession } from "./session.js";
