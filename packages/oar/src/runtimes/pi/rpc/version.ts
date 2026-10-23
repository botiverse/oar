import { readFileSync } from "node:fs";
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
