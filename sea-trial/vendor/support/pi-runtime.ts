import { createPiRuntime } from "../../../packages/oar/src/runtimes/pi/index.js";

/** The same public-contract checks exercise both bundled Pi execution locations. */
export const piRpc = process.env.OAR_TEST === "pi-rpc-aimock";
export const isPiBackend = piRpc || process.env.OAR_TEST === "pi-aimock";
export const piTestRuntime = createPiRuntime({ execution: piRpc ? "subprocess" : "in-process" });
export const piSession = piTestRuntime.session;
