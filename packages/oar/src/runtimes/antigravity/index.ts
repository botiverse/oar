import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { antigravityInstallation } from "./installation.js";
import { antigravityListModels } from "./list-models.js";
import { antigravitySession } from "./session.js";

export const antigravityRuntime = defineRuntime({
  id: "antigravity",
  brand: runtimeBrands.antigravity,
  installation: antigravityInstallation,
  session: antigravitySession,
  listModels: antigravityListModels,
});

export { antigravitySession } from "./session.js";
