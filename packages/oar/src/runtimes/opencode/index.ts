import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeSession } from "./session.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  brand: runtimeBrands.opencode,
  installation: opencodeInstallation,
  session: opencodeSession,
  listModels: opencodeListModels,
});

export { opencodeSession } from "./session.js";
