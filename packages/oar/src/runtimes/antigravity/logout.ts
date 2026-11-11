import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LogoutOptions, LogoutResult } from "../../contracts/login.js";
import { queryAcpAuth } from "../../shared/acp/auth-query.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { loginExecutable } from "../../shared/login.js";
import { confirmedLogout, statusAfterLogout, type NativeLogout } from "../../shared/logout.js";
import { readAntigravityAuthStatus } from "./auth.js";

/**
 * Antigravity's own sign-out: ACP `logout` on `agy acp`, which agy 1.5.5
 * declares (`agentCapabilities.auth.logout`) and answers `{}` after removing
 * its stored sign-in (`antigravity-oauth-token`), checked in an empty HOME
 * (docs/runtimes/antigravity.md#logout). OAR never touches the file; `agy
 * models` then decides whether it is signed out. Print mode refuses `/logout`,
 * so this is the one non-interactive channel.
 */
export async function antigravityLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const startedAt = Date.now();
  const target = loginExecutable(installation, "agy", undefined, sessionEnvironment(options.env));
  if (target.kind === "settled") { return target.result; }
  const result = await queryAcpAuth(target.installation.command, { method: "logout" }, "Antigravity", { ...options, timeoutMs: options.timeoutMs ?? 60_000 }).catch(() => "failed" as const);
  if (result === "unsupported") { return { kind: "unsupported", reason: "version_unsupported", detail: "This agy build has no ACP logout" }; }
  const native: NativeLogout = result === "ok" ? { kind: "done" } : {
    kind: "failed", reason: result === "timed_out" ? "timed_out" : "process_failed", detail: "agy ACP logout did not complete",
  };
  return confirmedLogout(native, await readAntigravityAuthStatus(installation, { env: options.env, ...statusAfterLogout(startedAt, options.timeoutMs) }), "agy acp logout");
}
