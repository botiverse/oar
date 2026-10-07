import { runtimeBrands } from "../../brands.js";
import { claudeSkills, claudeMcpServers, claudeTools } from "./inventory.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAuthStatus, claudeLogin } from "./login.js";
import { claudeLogout } from "./logout.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInstallation } from "./installation.js";
import { claudeListModels } from "./list-models.js";
import { claudeCheckUpdate, claudeUpgrade } from "./update.js";
import { claudeSession } from "./session.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  brand: runtimeBrands.claude,
  skills: claudeSkills,
  mcpServers: claudeMcpServers,
  tools: claudeTools,

  installation: claudeInstallation,
  accountUsage: claudeAccountUsage,
  listModels: claudeListModels,
  checkUpdate: claudeCheckUpdate,
  upgrade: claudeUpgrade,
  login: claudeLogin,
  logout: claudeLogout,
  authStatus: claudeAuthStatus,
  session: claudeSession,
});

export { claudeAccountUsage } from "./account-usage.js";
export { claudeListModels, projectClaudeModels } from "./list-models.js";
export { claudeSession } from "./session.js";
