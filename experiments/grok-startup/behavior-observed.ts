import { observeGrokProcesses } from "./observe-process.js";

if (process.env.OAR_TEST !== "grok-aimock") { throw new Error("This observation entry requires grok-aimock"); }
observeGrokProcesses(() => ({ suite: "behavior" }));
await import("../../sea-trial/main.js");
