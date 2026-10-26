import { UnsupportedOptionError } from "../contracts/errors.js";
import type { SessionOptions } from "../contracts/session-options.js";

/** In-process readers cannot change the environment without changing their host. */
export function refuseReaderEnvironment(env: SessionOptions["env"], reason: string): void {
  if (Object.keys(env ?? {}).length > 0) { throw new UnsupportedOptionError("env", reason); }
}
