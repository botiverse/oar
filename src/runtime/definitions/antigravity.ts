import { antigravityDriver } from "../../discovery/host/drivers/antigravity.js";
import { defineCommandRuntime } from "../command-definition.js";

export default defineCommandRuntime({
  id: "antigravity",
  commands: ["agy"],
  createDriver: antigravityDriver,
});
