import { defineRuntime } from "../../contracts/runtime.js";
import { claudeAccountUsage } from "./account-usage.js";
import { claudeInstallation } from "./installation.js";
import { claudeSession } from "./session.js";

export const claudeRuntime = defineRuntime({
  id: "claude",
  installation: claudeInstallation,
  accountUsage: claudeAccountUsage,
  session: claudeSession,
});

export { claudeAccountUsage } from "./account-usage.js";
export { claudeSession } from "./session.js";
