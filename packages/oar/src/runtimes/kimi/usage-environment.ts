import type { SessionOptions } from "../../contracts/session-options.js";
import { accountUsageEnvironment } from "../../shared/usage-environment.js";

/** The CLI and credential paths are scoped; HTTP still runs in the host process. */
export function kimiUsageEnvironment(overlay: SessionOptions["env"]): NodeJS.ProcessEnv {
  return accountUsageEnvironment("Kimi", overlay);
}
