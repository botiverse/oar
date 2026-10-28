import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LogoutOptions, LogoutResult } from "../../contracts/login.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { loginExecutable } from "../../shared/login.js";
import { confirmedLogout, type NativeLogout } from "../../shared/logout.js";
import { kimiAuthStatus, queryKimiAuth } from "./auth-status.js";

/** ACP logout removes the managed OAuth slot and its managed model configuration. */
export async function kimiLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const target = loginExecutable(installation, "Kimi", "2.3.3", sessionEnvironment(options.env));
  if (target.kind === "settled") { return target.result; }
  const result = await queryKimiAuth(target.installation.command, "logout", { ...options, timeoutMs: options.timeoutMs ?? 60_000 }).catch(() => "failed");
  if (result === "unsupported") { return { kind: "unsupported", reason: "version_unsupported", detail: "This Kimi build has no ACP logout" }; }
  const native: NativeLogout = result === "ok" ? { kind: "done" } : {
    kind: "failed", reason: result === "timed_out" ? "timed_out" : "process_failed", detail: "Kimi ACP logout did not complete",
  };
  return confirmedLogout(native, await kimiAuthStatus(installation, { env: options.env }), "kimi acp logout");
}
