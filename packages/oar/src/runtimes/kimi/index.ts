import { defineRuntime } from "../../contracts/runtime.js";
import { kimiAccountUsage } from "./account-usage.js";
import { kimiInstallation } from "./installation.js";
import { kimiListModels } from "./list-models.js";
import { kimiSession } from "./session.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  installation: kimiInstallation,
  accountUsage: kimiAccountUsage,
  listModels: kimiListModels,
  session: kimiSession,
});

export { kimiAccountEmail, kimiAccountUsage, projectKimiUsage } from "./account-usage.js";
export { kimiListModels } from "./list-models.js";
export { kimiSession } from "./session.js";
