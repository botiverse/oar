import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { kimiAccountUsage } from "./account-usage.js";
import { kimiInstallation } from "./installation.js";
import { kimiListModels } from "./list-models.js";
import { kimiSession } from "./session.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  brand: runtimeBrands.kimi,
  installation: kimiInstallation,
  accountUsage: kimiAccountUsage,
  listModels: kimiListModels,
  session: kimiSession,
});

export { kimiAccountUsage, projectKimiUsage } from "./account-usage.js";
export { kimiAccountDisplayName, kimiAccountEmail } from "./profile.js";
export { kimiListModels, projectKimiModels } from "./list-models.js";
export { kimiSession } from "./session.js";
