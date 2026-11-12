import type { RuntimeBrand } from "../../contracts/brand.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { bottegaInstallation } from "./installation.js";
import { bottegaRefusedSessionOptions } from "./options.js";
import { bottegaSession } from "./session.js";

/** Bottega has no mark yet. */
const bottegaBrand: RuntimeBrand = { name: "Bottega", icon: null };

/** A bottega runtime: its probe and refusals are always there. */
export type BottegaRuntime = Runtime & Required<Pick<Runtime, "installation" | "refusedSessionOptions">>;

/**
 * Bottega, driven through `bottega serve` (docs/runtimes/bottega.md). A
 * community runtime: not in the built-in `runtimes` registry; a host adds it
 * with `createRuntimeRegistry([...defaultRuntimes.list(), createBottegaRuntime()])`.
 */
export function createBottegaRuntime(): BottegaRuntime {
  return defineRuntime({
    id: "bottega",
    sessionCapabilities: () => ({ taskEventTypes: [], steer: true, images: false }),
    brand: bottegaBrand,
    installation: bottegaInstallation,
    session: bottegaSession,
    refusedSessionOptions: bottegaRefusedSessionOptions,
  }, { execution: "process" });
}

export { BOTTEGA_SERVE_PROTOCOL } from "./control.js";
export { BOTTEGA_THINKING_LEVELS } from "./options.js";
