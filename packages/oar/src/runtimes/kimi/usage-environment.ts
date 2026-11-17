import { environmentValue } from "../../shared/environment.js";
import type { SessionOptions } from "../../contracts/session-options.js";
import { accountUsageEnvironment } from "../../shared/usage-environment.js";

/** The CLI and credential paths are scoped; the read-only fallback still uses host HTTP. */
export function kimiUsageEnvironment(overlay: SessionOptions["env"]): NodeJS.ProcessEnv {
  return accountUsageEnvironment("Kimi", overlay);
}

/** Native Kimi deliberately disables its cross-process refresh lock on Windows. */
export function kimiUsageHasNativeLock(env: NodeJS.ProcessEnv): boolean {
  return (process.platform === "linux" || process.platform === "darwin") && environmentValue(env, "KIMI_DISABLE_OAUTH_LOCK") !== "1";
}
