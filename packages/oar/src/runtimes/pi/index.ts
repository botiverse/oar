import { defineRuntime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";

/**
 * The bundled Pi runtime, embedded through the Pi SDK dependency. Account
 * usage is intentionally absent: Pi runs on provider API keys and has no
 * subscription usage surface to observe.
 */
export const piRuntime = defineRuntime({
  id: "pi",
  installation: piInstallation,
});
