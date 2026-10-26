import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session-options.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";

/** RPC has no tools/providers query; the SDK fallback cannot isolate even custom variables. */
export function refuseChangedPiReaderEnvironment(overlay: SessionOptions["env"]): void {
  const environment = sessionEnvironment(overlay);
  const changed = Object.keys(overlay ?? {}).filter((name) => environmentValue(environment, name) !== environmentValue(process.env, name));
  if (changed.length > 0) {
    throw new UnsupportedOptionError("env", `Pi RPC does not provide this reader, and the host SDK cannot isolate environment changes: ${changed.join(", ")}`);
  }
}
