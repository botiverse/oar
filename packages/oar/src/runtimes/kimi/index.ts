import { defineRuntime } from "../../contracts/runtime.js";
import { kimiInstallation } from "./installation.js";
import { kimiSession } from "./session.js";

export const kimiRuntime = defineRuntime({
  id: "kimi",
  installation: kimiInstallation,
  session: kimiSession,
});

export { kimiSession } from "./session.js";
