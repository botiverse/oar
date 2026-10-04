import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { morphInstallation } from "./installation.js";
import { morphListModels } from "./list-models.js";
import { morphRefusedSessionOptions, morphSession } from "./session.js";

export const morphRuntime = defineRuntime({
  id: "morph",
  brand: runtimeBrands.morph,
  installation: morphInstallation,
  listModels: morphListModels,
  session: morphSession,
  refusedSessionOptions: morphRefusedSessionOptions,
});

export { morphListModels, projectMorphModels } from "./list-models.js";
export { morphSession } from "./session.js";
