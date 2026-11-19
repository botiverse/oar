import { assertQueryTimeout } from "../../shared/executable/query.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus } from "../../contracts/login.js";
import { queryAcpAuth, type AcpAuthQuery, type AcpAuthOptions } from "../../shared/acp/auth-query.js";

export type KimiAuthQuery = AcpAuthQuery;
const SOURCE = "kimi acp authenticate";

/** Native authenticate only checks readiness; it never drives terminal-auth or creates a session. */
export async function queryKimiAuth(command: string, method: "authenticate" | "logout", options: AcpAuthOptions): Promise<KimiAuthQuery> {
  const result = await queryAcpAuth(command, method === "authenticate" ? { method, methodId: "login" } : { method }, "Kimi", options);
  return result;
}

/** The auth gate reads cached material; the whole ACP startup is not declared local-only. */
export async function readKimiAuthStatus(installation: AvailableInstallation, options: AcpAuthOptions = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") {
    assertQueryTimeout(options.timeoutMs ?? 20_000);
    return { kind: "unknown", source: SOURCE, detail: "Kimi authentication requires an executable" };
  }
  const result = await queryKimiAuth(installation.command, "authenticate", options);
  if (result === "ok" || result === "auth_required") { return { kind: result === "ok" ? "logged_in" : "logged_out", source: SOURCE }; }
  const detail = result === "timed_out" ? "Kimi authentication query timed out"
    : (result === "unsupported" ? "This Kimi build does not expose the authentication check"
    : "Kimi authentication query failed");
  return { kind: "unknown", source: SOURCE, detail };
}

export const kimiAuthStatus = readKimiAuthStatus;
