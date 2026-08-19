import { defineCommandRuntime } from "../command-definition.js";
import { geminiDriver } from "../../discovery/host/drivers/gemini.js";

export default defineCommandRuntime({
  id: "gemini",
  commands: ["gemini"],
  createDriver: geminiDriver,
});
