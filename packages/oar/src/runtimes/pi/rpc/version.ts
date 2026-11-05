import { readFileSync } from "node:fs";
import { RuntimeFailureError } from "../../../contracts/runtime-failure-error.js";
import { versionAtLeast } from "../../../shared/update.js";
import { asRecord, parseJson } from "../../../shared/json.js";

/** Pi's exported VERSION can be an embedding app's PI_PACKAGE_DIR metadata. */
export async function piRpcVersion(): Promise<string> {
  let entry = "";
  try { entry = import.meta.resolve("@earendil-works/pi-coding-agent"); }
  catch {
    // Single-file hosts have no package tree. Pi publishes these packages in
    // lockstep; unlike coding-agent.VERSION this export is a source constant.
    // The native version test pins that relationship for the bundled build.
    const { PI_AI_VERSION } = await import("@earendil-works/pi-ai");
    return PI_AI_VERSION;
  }
  const file = new URL("../package.json", entry);
  const manifest = asRecord(parseJson(readFileSync(file, "utf8")));
  if (typeof manifest?.version !== "string") { throw new TypeError("Cannot read OAR's Pi dependency version"); }
  return manifest.version;
}

/** Minimum native RPC version covered by the explicit-command vendor controls. */
export const PI_RPC_MINIMUM_VERSION = "1.4.0";

/** The default entry must match its bundle; an explicit command follows the tested floor. */
export function assertPiRpcVersion(actual: unknown, bundledVersion?: string): asserts actual is string {
  const stable = typeof actual === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(actual);
  if (stable && (bundledVersion === undefined ? versionAtLeast(actual, PI_RPC_MINIMUM_VERSION) : actual === bundledVersion)) { return; }
  const required = bundledVersion === undefined ? `at least ${PI_RPC_MINIMUM_VERSION}` : `${bundledVersion}, matching OAR's bundled Pi`;
  const reported = typeof actual === "string" && actual.length > 0 ? actual : "no readable version";
  throw new RuntimeFailureError("invalid_request", `Pi RPC requires ${required}; the selected runtime reports ${reported}. Select a supported Pi executable with createPiRuntime({ execution: "subprocess", command }).`);
}
