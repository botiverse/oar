import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import { binaryOnly } from "../runtimeProbe.js";

export function cursorDriver(): RuntimeDriver {
  return binaryOnly("cursor", "cursor-agent", async () => []);
}
