import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { antigravityLogin } from "./login.js";
import { antigravityInstallation } from "./installation.js";
import { antigravityListModels } from "./list-models.js";
import { antigravityCheckUpdate } from "./update.js";
import { antigravityRefusedSessionOptions, antigravitySession } from "./session.js";

export const antigravityRuntime = defineRuntime({
  id: "antigravity",
  brand: runtimeBrands.antigravity,
  installation: antigravityInstallation,
  login: antigravityLogin,
  session: antigravitySession,
  listModels: antigravityListModels,
  checkUpdate: antigravityCheckUpdate,
  refusedSessionOptions: antigravityRefusedSessionOptions,
});

export { antigravitySession } from "./session.js";
