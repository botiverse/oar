import { defineCommandRuntime } from "../command-definition.js";
import { grokCompatibility } from "../../discovery/install/policies.js";
import { grokDriver } from "../../discovery/host/drivers/grok.js";

export default defineCommandRuntime({
  id: "grok",
  commands: ["grok"],
  compatibility: grokCompatibility,
  createDriver: grokDriver,
});
