import { cursorDriver } from "../../discovery/host/drivers/cursor.js";
import { defineCommandRuntime } from "../command-definition.js";

export default defineCommandRuntime({
  id: "cursor",
  commands: ["cursor-agent"],
  createDriver: cursorDriver,
});
