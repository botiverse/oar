import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInstallation } from "./installation.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  installation: claudeInstallation,
  accountUsage: claudeAccountUsage,
});

export { claudeAccountUsage } from "./account-usage.js";
