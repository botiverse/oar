import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import { binaryOnly, modelsToInfo } from "../runtimeProbe.js";

export function copilotDriver(): RuntimeDriver {
  return binaryOnly("copilot", "copilot", async () =>
    modelsToInfo("copilot", [
      {
        id: "default",
        label: "default (CLI present; no model list API)",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
    ]),
  );
}
