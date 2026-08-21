import { defineRuntime } from "../../contracts/runtime.js";
import { createClaudeAccountUsage } from "./account-usage.js";
import { createClaudeInstallation } from "./installation.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  installation: createClaudeInstallation(),
  accountUsage: createClaudeAccountUsage(),
});

export { createClaudeAccountUsage, projectClaudeUsage } from "./account-usage.js";
export { createClaudeInstallation } from "./installation.js";
