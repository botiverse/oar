import { defineRuntime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";
import { piListModels } from "./list-models.js";
import { piSession } from "./session.js";

/**
 * The bundled Pi runtime, embedded through the Pi SDK dependency. Account
 * usage is intentionally absent: Pi runs on provider API keys and has no
 * subscription usage surface to observe.
 */
export const piRuntime = defineRuntime({
  id: "pi",
  installation: piInstallation,
  listModels: piListModels,
  session: piSession,
});

export { piListModels, projectPiModels } from "./list-models.js";
export { piSession } from "./session.js";
