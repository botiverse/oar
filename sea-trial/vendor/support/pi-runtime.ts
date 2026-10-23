import { execFileSync } from "node:child_process";
import { createPiRuntime } from "../../../packages/oar/src/runtimes/pi/index.js";

/** The same public-contract checks exercise both bundled Pi execution locations. */
export const piRpc = process.env.OAR_TEST === "pi-rpc-aimock";
export const isPiBackend = piRpc || process.env.OAR_TEST === "pi-aimock";
export const piTestRuntime = createPiRuntime({ execution: piRpc ? "subprocess" : "in-process" });
export const piSession = piTestRuntime.session;

/** POSIX resolves symlinks in process.cwd(); Windows can retain junctions and short paths. */
export function piChildCwd(cwd: string): string {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd, encoding: "utf8" });
}
