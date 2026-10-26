import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { InventoryOptions } from "../../contracts/inventory.js";
import type { SessionOptions } from "../../contracts/session-options.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";

function changedVariables(overlay: SessionOptions["env"]): string[] {
  const environment = sessionEnvironment(overlay);
  return Object.keys(overlay ?? {}).filter((name) => environmentValue(environment, name) !== environmentValue(process.env, name));
}

type Reader<Result> = (installation: AvailableInstallation, options?: InventoryOptions) => Promise<Result>;

/** Keep the richer host SDK query unless this call needs an isolated environment. */
export function piReaderForEnvironment<Result>(sdk: Reader<Result>, rpc: Reader<Result>): Reader<Result> {
  return async (installation, options) => {
    const read = changedVariables(options?.env).length === 0 ? sdk : rpc;
    const result = await read(installation, options);
    return result;
  };
}

/** RPC has no tools/providers query; the SDK fallback cannot isolate even custom variables. */
export function refuseChangedPiReaderEnvironment(overlay: SessionOptions["env"]): void {
  const changed = changedVariables(overlay);
  if (changed.length > 0) {
    throw new UnsupportedOptionError("env", `Pi RPC does not provide this reader, and the host SDK cannot isolate environment changes: ${changed.join(", ")}`);
  }
}
