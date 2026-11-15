import path from "node:path";
import { verifyCapture } from "./verify-capture.js";

const [behavior, vendor] = process.argv.slice(2);
const root = path.join(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "grok-processes");
for (const [suite, outcome] of [["behavior", behavior], ["vendor", vendor]] as const) {
  if (outcome !== "skipped") {
    const count = verifyCapture(path.join(root, suite));
    console.log(`${suite}: ${String(count)} Grok process traces retained`);
  }
}
