import { runtimeBrands } from "../../brands.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { cursorInstallation } from "./installation.js";
import { cursorListModelsWith } from "./list-models.js";
import { cursorRefusedSessionOptions } from "./model.js";
import { cursorSdkLoader, type CursorSdk } from "./sdk.js";
import { cursorSessionWith } from "./session.js";

export interface CursorRuntimeOptions {
  /**
   * Loads `@cursor/sdk` 1.0.36, which the host installs (an optional peer
   * dependency of OAR): `() => import("@cursor/sdk")`. Written in the host's
   * own code, the import fails the host's compile when the package is
   * missing, checks the SDK's types against `CursorSdk`, and is visible to
   * a bundler. Called on the first call that needs the SDK; a failed load is
   * retried by the next call.
   */
  readonly sdk: () => Promise<CursorSdk>;
}

/** A cursor runtime: its probe, model listing and refusals are always there. */
export type CursorRuntime = Runtime & Required<Pick<Runtime, "installation" | "listModels" | "refusedSessionOptions">>;

/**
 * Cursor, embedded through its official SDK (`@cursor/sdk`): the agent runs
 * in this process, the way pi does. It is not in `defaultRuntimes`, because
 * the SDK is the host's to install and hand over; a host that wants cursor
 * adds `createCursorRuntime({ sdk })` to its own registry
 * (docs/design/capabilities.md#a-runtimes-own-settings). Account usage is
 * absent: the SDK's usage call is not available to every account
 * (`feature_unavailable`, probed 2026-10-03), and each run reports its own
 * tokens anyway.
 */
export function createCursorRuntime(options: CursorRuntimeOptions): CursorRuntime {
  const load = cursorSdkLoader(options.sdk);
  return defineRuntime({
    id: "cursor",
    brand: runtimeBrands.cursor,
    installation: cursorInstallation,
    listModels: cursorListModelsWith(load),
    session: cursorSessionWith(load),
    refusedSessionOptions: cursorRefusedSessionOptions,
  });
}

export { projectCursorModels } from "./list-models.js";
