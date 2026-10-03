import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { cursorInstallation } from "./installation.js";
import { cursorListModels } from "./list-models.js";
import { cursorRefusedSessionOptions } from "./model.js";
import { cursorSession } from "./session.js";

/**
 * Cursor, embedded through its official SDK (`@cursor/sdk`): the agent runs
 * in this process, the way pi does. Account usage is absent: the SDK's
 * usage call is not available to every account (`feature_unavailable`,
 * probed 2026-10-03), and each run reports its own tokens anyway.
 */
export const cursorRuntime = defineRuntime({
  id: "cursor",
  brand: runtimeBrands.cursor,
  installation: cursorInstallation,
  listModels: cursorListModels,
  session: cursorSession,
  refusedSessionOptions: cursorRefusedSessionOptions,
});

export { cursorListModels, projectCursorModels } from "./list-models.js";
export { cursorSession } from "./session.js";
