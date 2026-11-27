import { piRpcTestOptions } from "../../harness/pi-rpc.js";
import { execFileSync } from "node:child_process";
import type { AvailableInstallation } from "../../../packages/oar/src/contracts/installation.js";
import { createPiRuntime } from "../../../packages/oar/src/runtimes/pi/index.js";
import type { PiRuntimeOptions } from "../../../packages/oar/src/runtimes/pi/options.js";

/** The same public-contract checks exercise both bundled Pi execution locations. */
export const piRpc = process.env.OAR_TEST === "pi-rpc-aimock";
export const isPiBackend = piRpc || process.env.OAR_TEST === "pi-aimock";
const piOptions: PiRuntimeOptions = piRpc ? piRpcTestOptions() : { execution: "in-process" };
export const piTestRuntime = createPiRuntime(piOptions);
export const piInstallation = piTestRuntime.installation;
export const piTestInstallation: AvailableInstallation = piOptions.command === undefined
  ? { kind: "available", via: "bundled" }
  : { kind: "available", via: "executable", command: piOptions.command };
export const piSession = piTestRuntime.session;

/** POSIX resolves symlinks in process.cwd(); Windows can retain junctions and short paths. */
export function piChildCwd(cwd: string): string {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd, encoding: "utf8" });
}
