import type { RuntimeBrand } from "../../contracts/brand.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { dimInstall, dimInstallPlan } from "./install.js";
import { dimInstallation } from "./installation.js";
import { dimRefusedSessionOptions } from "./options.js";

/** No icon: the Dim project publishes no standalone mark yet (docs/runtimes/dim.md). */
const dimBrand: RuntimeBrand = { name: "Dim", icon: null };

/** A dim runtime: its probe, installer and refusals are always there. */
export type DimRuntime = Runtime & Required<Pick<Runtime, "installation" | "install" | "installPlan" | "refusedSessionOptions">>;

/**
 * Dim, driven through its ACP gateway (`dima acp`, docs/runtimes/dim.md). A
 * community runtime: not in the built-in `runtimes` registry; a host adds it
 * with `createRuntimeRegistry([...defaultRuntimes.list(), createDimRuntime()])`.
 */
export function createDimRuntime(): DimRuntime {
  return defineRuntime({
    id: "dim",
    sessionCapabilities: () => ({ taskEventTypes: [], steer: false, stopTask: false }),
    manualCompaction: { kind: "unsupported", reason: "Dim's ACP gateway offers a /compact command, but OAR has not verified its completion signal." },
    brand: dimBrand,
    installation: dimInstallation,
    installPlan: dimInstallPlan,
    install: dimInstall,
    session: onFirstCall(async () => {
      const { dimSession } = await import("./session.js");
      return dimSession;
    }),
    refusedSessionOptions: dimRefusedSessionOptions,
  }, { execution: "process" });
}
