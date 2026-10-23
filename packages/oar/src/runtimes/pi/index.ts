import { runtimeBrands } from "../../brands.js";
import { createPiInventories } from "./inventory.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { piInstallation } from "./installation.js";
import { type piListModels, piModelLister } from "./list-models.js";
import { piRefusedSessionOptions } from "./open.js";
import { createPiSession } from "./session.js";

import type { PiRuntimeOptions } from "./options.js";

export type { PiRuntimeOptions } from "./options.js";

/**
 * The bundled Pi runtime, embedded through the Pi SDK dependency. Account
 * usage is intentionally absent: Pi runs on provider API keys and has no
 * subscription usage surface to observe.
 */
export function createPiRuntime(options: PiRuntimeOptions = {}): Runtime & { readonly installation: typeof piInstallation; readonly listModels: typeof piListModels } {
  return defineRuntime({
    id: "pi",
    brand: runtimeBrands.pi,
    refusedSessionOptions: piRefusedSessionOptions,
    mcpToolsListChanged: "full",
    ...createPiInventories(options),
    installation: piInstallation,
    listModels: piModelLister(options),
    session: createPiSession(options),
  });
}

export const piRuntime = createPiRuntime();

export { piListModels, projectPiModels } from "./list-models.js";
export { piSession } from "./session.js";
