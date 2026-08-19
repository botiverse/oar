import { copilotDriver } from "../../discovery/host/drivers/copilot.js";
import { defineCommandRuntime } from "../command-definition.js";

export default defineCommandRuntime({
  id: "copilot",
  commands: ["copilot"],
  createDriver: copilotDriver,
});
