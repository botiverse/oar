import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { cursorInstallation } from "./installation.js";
import { cursorListModels } from "./list-models.js";
import { cursorCheckUpdate, cursorUpgrade } from "./update.js";
import { cursorSession } from "./session.js";

export const cursorRuntime = defineRuntime({
  id: "cursor",
  brand: runtimeBrands.cursor,
  installation: cursorInstallation,
  listModels: cursorListModels,
  checkUpdate: cursorCheckUpdate,
  upgrade: cursorUpgrade,
  session: cursorSession,
});

export { cursorListModels, projectCursorModels } from "./list-models.js";
export { cursorSession } from "./session.js";
