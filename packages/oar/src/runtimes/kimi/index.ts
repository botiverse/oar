import { defineRuntime } from "../../contracts/runtime.js";
import { kimiAccountUsage } from "./account-usage.js";
import { kimiInstallation } from "./installation.js";
import { kimiSession } from "./session.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  installation: kimiInstallation,
  accountUsage: kimiAccountUsage,
  session: kimiSession,
});

export { kimiAccountEmail, kimiAccountUsage, projectKimiUsage } from "./account-usage.js";
export { kimiSession } from "./session.js";
