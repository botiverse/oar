import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import { binaryOnly } from "../runtimeProbe.js";

export function geminiDriver(): RuntimeDriver {
  return binaryOnly("gemini", "gemini", async () => []);
}
