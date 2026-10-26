import { sessionEnvironment } from "../../shared/environment.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LoginOptions, LoginResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { errorMessage, LoginSecrets, loginBounds, loginExecutable, spawnLoginProcess, stoppedResult, type LoginProcess } from "../../shared/login.js";
import { qoderAuthStatus } from "./auth-status.js";

/** Native browser login restores the previous account first and does not log it out before an attempt. */
export async function qoderLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: LoginOptions = {}): Promise<LoginResult> {
  const target = loginExecutable(installation, "Qoder", undefined, sessionEnvironment(options.env));
  if (target.kind === "settled") { return target.result; }
  const aborted = (): boolean => interaction.signal?.aborted === true;
  if (aborted()) { return { kind: "cancelled" }; }
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const bounds = loginBounds(interaction.signal, timeoutMs);
  const failedInteraction = Promise.withResolvers<LoginResult>();
  const secrets = new LoginSecrets();
  const urls = new Set<string>();
  let child: LoginProcess | undefined = undefined;
  const flowState = { success: false };
  let rejected = false;
  let settled = false;
  const env = sessionEnvironment(options.env);
  if (options.openBrowser === false) {
    // Native login 1.1.78 does not consult NO_BROWSER. Its browser eligibility
    // predicate explicitly rejects BROWSER=www-browser on every platform.
    env.BROWSER = "www-browser";
  }
  try {
    child = spawnLoginProcess(target.installation.command, ["login"], env, {
      onLine(line) {
        if (settled) { return; }
        flowState.success ||= /^Login successful!|^Already logged in as /u.test(line);
        rejected ||= line.startsWith("Login failed:");
        // Only the standalone browser URL, never surrounding identity or diagnostics.
        if (!/^https?:\/\/\S+$/u.test(line) || urls.has(line)) { return; }
        urls.add(line);
        try { interaction.onEvent({ kind: "auth_url", url: line, instructions: "Open this URL to sign in to Qoder." }); }
        catch (error) {
          settled = true;
          failedInteraction.resolve({ kind: "failed", reason: "interaction_failed", detail: secrets.line(errorMessage(error)) });
        }
      },
    });
    const process = child;
    const exited = async (): Promise<LoginResult> => {
      const exit = await process.exited;
      return flowState.success ? { kind: "logged_in" } : (rejected
        ? { kind: "failed", reason: "rejected", detail: "Qoder reported that login failed" }
        : { kind: "failed", reason: "process_failed", detail: `Qoder login ended without a success report (exit ${String(exit.exitCode)})` });
    };
    const stopped = async (): Promise<LoginResult> => stoppedResult(await bounds.stopped, timeoutMs);
    const result = await Promise.race([exited(), stopped(), failedInteraction.promise]);
    settled = true;
    process.stop(); await process.exited;
    if (!flowState.success) { return result; }
    if (aborted()) { return { kind: "logged_in" }; }
    const status = await qoderAuthStatus(installation, { env: options.env });
    return status.kind === "logged_out"
      ? { kind: "failed", reason: "not_logged_in", detail: "Qoder reported success but its status command reads logged out" }
      : { kind: "logged_in" };
  } catch {
    return { kind: "failed", reason: "process_failed", detail: "Qoder login could not start" };
  } finally { settled = true; bounds.dispose(); child?.stop(); await child?.exited; }
}
