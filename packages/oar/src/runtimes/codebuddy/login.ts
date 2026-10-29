import { sessionEnvironment } from "../../shared/environment.js";
import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LoginOptions, LoginResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { errorMessage, loginBounds, loginExecutable, stoppedResult } from "../../shared/login.js";
import { asRecord } from "../../shared/json.js";
import { codebuddyAccountControl } from "./account-control.js";
import { codebuddyAuthStatus } from "./auth-status.js";

/** Native auth_failed includes token retrieval errors, not an explicit authorization denial. */
function authenticationFailure(value: unknown, redact: (text: string) => string): LoginResult {
  const error = asRecord(value);
  if (error?.type === "cancelled") { return { kind: "cancelled" }; }
  const reason = error?.type === "timeout" ? "timed_out" : "process_failed";
  return { kind: "failed", reason, detail: typeof error?.message === "string" ? redact(error.message) : "CodeBuddy reported that authentication failed" };
}

/** Keep the CLI's current account environment, including CODEBUDDY_INTERNET_ENVIRONMENT. */
export async function codebuddyLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: LoginOptions = {}): Promise<LoginResult> {
  const target = loginExecutable(installation, "CodeBuddy", undefined, sessionEnvironment(options.env));
  if (target.kind === "settled") { return target.result; }
  const aborted = (): boolean => interaction.signal?.aborted === true;
  if (aborted()) { return { kind: "cancelled" }; }
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const bounds = loginBounds(interaction.signal, timeoutMs);
  const interactionFailed = Promise.withResolvers<LoginResult>();
  let client: ReturnType<typeof codebuddyAccountControl> | undefined = undefined;
  const flowState: { success: boolean; failure?: LoginResult } = { success: false };
  let settled = false;
  const env = sessionEnvironment(options.env);
  if (options.openBrowser === false) {
    // CodeBuddy's UrlUtils honors BROWSER and does not fall back when it fails.
    env.BROWSER = process.platform === "win32" ? path.join(env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe") : "true";
  }
  try {
    client = codebuddyAccountControl(target.installation.command, env, (request) => {
      if (settled) { return; }
      if (request.subtype === "auth_result_callback" && request.success === true) { flowState.success = true; }
      if (request.subtype === "auth_result_callback" && request.success === false && asRecord(request.error) !== null) {
        flowState.failure = authenticationFailure(request.error, (text) => client?.secrets.line(text) ?? "CodeBuddy authentication failed");
      }
      const auth = asRecord(request.authState);
      if (request.subtype === "auth_url_callback" && typeof auth?.authUrl === "string") {
        try { interaction.onEvent({ kind: "auth_url", url: auth.authUrl, instructions: "Open this URL to sign in to CodeBuddy." }); }
        catch (error) {
          settled = true;
          interactionFailed.resolve({ kind: "failed", reason: "interaction_failed", detail: client?.secrets.line(errorMessage(error)) ?? "Could not display the login link" });
        }
      }
    });
    const control = client;
    const flow = async (): Promise<LoginResult> => {
      await control.request({ subtype: "initialize" });
      if (settled) { return { kind: "failed", reason: "interaction_failed" }; }
      // 2.173.0 lists cli-external-link but its provider inherits a different
      // getAuthenticationType. Leave selection to native support(), as the TUI does.
      const answer = await control.request({ subtype: "authenticate" });
      flowState.success ||= answer.success === true;
      return flowState.success ? { kind: "logged_in" } : flowState.failure ?? authenticationFailure(answer.error, (text) => control.secrets.line(text));
    };
    const stopped = async (): Promise<LoginResult> => stoppedResult(await bounds.stopped, timeoutMs);
    let result: LoginResult = { kind: "failed", reason: "process_failed" };
    try { result = await Promise.race([flow(), stopped(), interactionFailed.promise]); }
    catch (error) { result = flowState.failure ?? { kind: "failed", reason: "process_failed", detail: control.secrets.line(errorMessage(error)) }; }
    settled = true;
    control.process.stop(); await control.process.exited;
    if (!flowState.success) { return result; }
    if (aborted()) { return { kind: "logged_in" }; }
    // Confirmation shares the login deadline and cancellation signal. A
    // native success remains success unless a fresh read contradicts it.
    const remaining = deadline - Date.now();
    if (remaining <= 0) { return { kind: "logged_in" }; }
    const status = await codebuddyAuthStatus(installation, { env: options.env, timeoutMs: Math.min(30_000, remaining) }, interaction.signal);
    return status.kind === "logged_out"
      ? { kind: "failed", reason: "not_logged_in", detail: "CodeBuddy reported success but its account query reads logged out" }
      : { kind: "logged_in" };
  } catch {
    return { kind: "failed", reason: "process_failed", detail: "CodeBuddy login could not start" };
  } finally {
    settled = true; bounds.dispose(); client?.process.stop(); await client?.process.exited;
  }
}
