import { defineCommandRuntime } from "../command-definition.js";
import { opencodeCompatibility } from "../../discovery/install/policies.js";
import { opencodeDriver } from "../../discovery/host/drivers/opencode.js";

export default defineCommandRuntime({
  id: "opencode",
  commands: ["opencode"],
  compatibility: opencodeCompatibility,
  createDriver: opencodeDriver,
});
