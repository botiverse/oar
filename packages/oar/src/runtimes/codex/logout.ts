import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LogoutOptions, LogoutResult } from "../../contracts/login.js";
import { loginExecutable } from "../../shared/login.js";
import { commandLogout, confirmedLogout, runLogoutCommand } from "../../shared/logout.js";
import { codexAuthStatus } from "./login.js";

/*
 * `codex logout` (0.160.1, read in openai/codex `rust-v0.160.1`:
 * `cli/src/login.rs` `run_logout`, `login/src/auth/manager.rs`
 * `logout_with_revoke`, `login/src/auth/revoke.rs`): it revokes a stored
 * ChatGPT login's refresh token (or its access token) at
 * `https://auth.openai.com/oauth/revoke`, 10 s and best effort (a failed
 * revoke is logged and the local logout goes on; since 0.122.0), then
 * deletes the credential store, `$CODEX_HOME/auth.json` and the keyring
 * entry. A stored API key is only deleted. It prints to stderr and exits 0
 * with `Successfully logged out`, or `Not logged in` when nothing was
 * stored; a failure is `Error logging out: <error>` (or an unreadable
 * configuration's error) with exit 1. `OPENAI_API_KEY` and `CODEX_API_KEY`
 * are untouched; `codex login status` does not read them either. `codex
 * logout` arrived in 0.15.0.
 */
const LOGOUT_FLOOR = "0.15.0";
const LOGOUT_COMMAND = "codex logout";
/** The revoke has 10 s. */
const LOGOUT_TIMEOUT_MS = 60_000;

/** Signs codex out with `codex logout`; `codex login status` decides. */
export async function codexLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const target = loginExecutable(installation, "codex", LOGOUT_FLOOR);
  if (target.kind === "settled") {
    return target.result;
  }
  const timeoutMs = options.timeoutMs ?? LOGOUT_TIMEOUT_MS;
  const end = await runLogoutCommand(target.installation.command, ["logout"], process.env, timeoutMs);
  if (end.kind === "not_started") {
    return { kind: "failed", reason: "process_failed", detail: end.detail };
  }
  const native = commandLogout(end, LOGOUT_COMMAND, timeoutMs);
  return confirmedLogout(native, await codexAuthStatus(installation), LOGOUT_COMMAND);
}
