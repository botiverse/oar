/**
 * OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-startup.ts
 * Native initialize timings with isolated unauthenticated HOMEs and no prompt.
 * OAR_QODER_STARTUP_PROBE=1 opts into the same controls before the behavior suite.
 */
import { measureQoderStartup } from "../sea-trial/harness/qoder-startup.js";

await measureQoderStartup({ kind: "available", via: "executable", command: process.env.OAR_QODER_BIN ?? "qodercli" });
