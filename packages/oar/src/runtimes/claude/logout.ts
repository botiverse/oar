import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LogoutOptions, LogoutResult } from "../../contracts/login.js";
import { loginExecutable } from "../../shared/login.js";
import { commandLogout, confirmedLogout, runLogoutCommand } from "../../shared/logout.js";
import { claudeEnv, readClaudeAuthStatus } from "./auth-status.js";

/*
 * `claude auth logout` (2.1.292, read in its bundle: `authLogout`, then
 * `performLogout`): it revokes the stored claude.ai OAuth refresh token
 * (`POST <token URL>/revoke`, 5 s, best effort: a failed revoke is logged
 * and the local logout goes on), then deletes the stored credentials
 * (`~/.claude/.credentials.json`, the macOS Keychain) and the account in
 * `~/.claude.json`. It prints `Successfully logged out from your Anthropic
 * account.` and exits 0, also when nothing was stored; a failure is
 * `Logout failed: <message>` on stderr with exit 1. Credentials from the
 * environment (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are not its
 * to remove: the status still reads logged in with them.
 * `auth logout` arrived in 2.1.41, with `auth login` and `auth status`.
 */
const LOGOUT_FLOOR = "2.1.41";
const LOGOUT_COMMAND = "claude auth logout";
/** The revoke has 5 s; telemetry is flushed before and after. */
const LOGOUT_TIMEOUT_MS = 60_000;
const FAILURE = /^Logout failed:\s*(.*)$/u;

/** Signs claude out with `claude auth logout`; `claude auth status --json` decides. */
export async function claudeLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const target = loginExecutable(installation, "claude", LOGOUT_FLOOR);
  if (target.kind === "settled") {
    return target.result;
  }
  const timeoutMs = options.timeoutMs ?? LOGOUT_TIMEOUT_MS;
  const end = await runLogoutCommand(target.installation.command, ["auth", "logout"], claudeEnv(), timeoutMs);
  if (end.kind === "not_started") {
    return { kind: "failed", reason: "process_failed", detail: end.detail };
  }
  const native = commandLogout(end, LOGOUT_COMMAND, timeoutMs, FAILURE);
  const read = await readClaudeAuthStatus(installation);
  return confirmedLogout(native, read.status, LOGOUT_COMMAND, read.apiKeySource === undefined ? [] : [`from ${read.apiKeySource}`]);
}
