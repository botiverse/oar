import path from "node:path";
import { afterAll, expect } from "vitest";
import { observeGrokProcesses } from "./observe-process.js";

if (process.env.OAR_TEST === "grok-aimock") {
  const restore = observeGrokProcesses(() => ({ suite: "vendor", file: path.basename(expect.getState().testPath ?? ""), test: expect.getState().currentTestName ?? null }));
  afterAll(restore);
}
