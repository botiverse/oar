import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LogoutOptions, LogoutResult } from "../../contracts/login.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { loginBounds, loginExecutable } from "../../shared/login.js";
import { confirmedLogout, statusAfterLogout, type NativeLogout } from "../../shared/logout.js";
import { codebuddyAccountControl, CodebuddyAccountRefusalError } from "./account-control.js";
import { readCodebuddyAuthStatus } from "./auth-status.js";

const COMMAND = "codebuddy stream-json logout";
const LOGOUT_TIMEOUT_MS = 60_000;

/**
 * CodeBuddy's own sign-out: the `logout` control request of its stream-json
 * protocol (2.183.0, isolated HOME, 2026-11-11), which runs the CLI's
 * `AuthenticationManager.logout()` and answers `{success: true}`. It clears
 * the local sign-in; it does not revoke the session on the server (that path
 * needs `revokeServerSession`, which this request does not set). OAR never
 * touches the credential; `initialize.account` then decides.
 */
async function nativeLogout(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<NativeLogout> {
  const bounds = loginBounds(undefined, timeoutMs);
  let control: ReturnType<typeof codebuddyAccountControl> | undefined = undefined;
  try {
    control = codebuddyAccountControl(command, env);
    const open = control;
    const ask = async (): Promise<NativeLogout> => {
      try {
        await open.request({ subtype: "logout" });
        return { kind: "done" };
      } catch (error) {
        // Its refusal text can name the account (not yet known to the redactor here): never relayed.
        return error instanceof CodebuddyAccountRefusalError
          ? { kind: "failed", reason: "rejected", detail: "CodeBuddy refused its logout" }
          : { kind: "failed", reason: "process_failed", detail: "CodeBuddy ended before answering its logout" };
      }
    };
    const timedOut = async (): Promise<NativeLogout> => { await bounds.stopped; return { kind: "failed", reason: "timed_out", detail: `${COMMAND} did not answer within ${String(timeoutMs)} ms` }; };
    return await Promise.race([ask(), timedOut()]);
  } catch {
    return { kind: "failed", reason: "process_failed", detail: "CodeBuddy could not start" };
  } finally { bounds.dispose(); control?.process.stop(); await control?.process.exited; }
}

/** Signs CodeBuddy out through its stream-json `logout`; its `initialize.account` decides. */
export async function codebuddyLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const startedAt = Date.now();
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "CodeBuddy", undefined, env);
  if (target.kind === "settled") { return target.result; }
  const native = await nativeLogout(target.installation.command, env, options.timeoutMs ?? LOGOUT_TIMEOUT_MS);
  return confirmedLogout(native, await readCodebuddyAuthStatus(installation, { env: options.env, ...statusAfterLogout(startedAt, options.timeoutMs) }), COMMAND);
}
