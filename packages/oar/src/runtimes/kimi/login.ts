import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LoginOptions, LoginResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { loginBounds, loginExecutable, spawnLoginProcess, stoppedResult, type LoginProcess } from "../../shared/login.js";
import { queryKimiAuth } from "./auth-status.js";
import { kimiLoginBrowser, type KimiLoginBrowser } from "./login-browser.js";

export interface KimiLoginOptions extends LoginOptions {
  /** Omitted: Kimi resolves its persisted login, environment and install-region marker. */
  readonly region?: "mainland-cn" | "global";
}

/** Native login owns OAuth storage and model provisioning; OAR never copies or rolls back credentials. */
export async function kimiLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: KimiLoginOptions = {}): Promise<LoginResult> {
  if (options.region !== undefined && !["mainland-cn", "global"].includes(options.region)) { throw new RangeError("Kimi region must be mainland-cn or global"); }
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "Kimi", "2.3.3", env);
  if (target.kind === "settled") { return target.result; }
  const aborted = (): boolean => interaction.signal?.aborted === true;
  if (aborted()) { return { kind: "cancelled" }; }
  let browser: KimiLoginBrowser | undefined = undefined;
  if (options.openBrowser === false) {
    try { browser = await kimiLoginBrowser(env); }
    catch { return { kind: "unsupported", reason: "browser_suppression_unavailable", detail: "Kimi cannot safely suppress its browser on this machine; use a temporary directory outside the working directory or allow local browser opening" }; }
  }
  try {
    if (aborted()) { return { kind: "cancelled" }; }
    return await runKimiLogin(target.installation.command, interaction, options, browser?.env ?? env);
  } finally { await browser?.dispose(); }
}

async function runKimiLogin(command: string, interaction: ProviderLoginInteraction, options: KimiLoginOptions, env: NodeJS.ProcessEnv): Promise<LoginResult> {
  const timeoutMs = options.timeoutMs ?? 16 * 60_000;
  const bounds = loginBounds(interaction.signal, timeoutMs);
  const failedInteraction = Promise.withResolvers<LoginResult>();
  let child: LoginProcess | undefined = undefined;
  const state = { success: false, rejected: false, settled: false, url: "", emitted: "" };
  try {
    child = spawnLoginProcess(command, ["login", ...(options.region === undefined ? [] : ["--region", options.region])], env, {
      onLine(line, stream) {
        if (state.settled || stream !== "stderr") { return; }
        state.success ||= /^Logged in to .+\.$/u.test(line);
        state.rejected ||= /^Login (?:failed|cancelled)[.:]/u.test(line);
        const url = /^Opening browser for Kimi device login: (https?:\/\/\S+)$/u.exec(line)?.[1];
        if (url !== undefined) { state.url = url; }
        const code = /^If the browser did not open, paste the URL above and enter code: (\S+)$/u.exec(line)?.[1];
        if (code === undefined || state.url === "" || state.emitted === `${state.url}\n${code}`) { return; }
        state.emitted = `${state.url}\n${code}`;
        try { interaction.onEvent({ kind: "device_code", userCode: code, verificationUri: state.url }); }
        catch {
          state.settled = true;
          failedInteraction.resolve({ kind: "failed", reason: "interaction_failed", detail: "Could not present the Kimi device code" });
        }
      },
    });
    const process = child;
    const exited = async (): Promise<LoginResult> => {
      await process.exited;
      return state.success ? { kind: "logged_in" } : {
        kind: "failed", reason: state.rejected ? "rejected" : "process_failed",
        detail: state.rejected ? "Kimi reported that login failed" : "Kimi login ended without reporting success",
      };
    };
    const stopped = async (): Promise<LoginResult> => stoppedResult(await bounds.stopped, timeoutMs);
    const result = await Promise.race([exited(), stopped(), failedInteraction.promise]);
    state.settled = true;
    process.stop(); await process.exited;
    if (!state.success) { return result; }
    if (interaction.signal?.aborted === true) { return { kind: "logged_in" }; }
    const status = await queryKimiAuth(command, "authenticate", { env: options.env, ...(interaction.signal === undefined ? {} : { signal: interaction.signal }) }).catch(() => "failed");
    return status === "auth_required"
      ? { kind: "failed", reason: "not_logged_in", detail: "Kimi reported login success but its authentication check still requires login" }
      : { kind: "logged_in" };
  } catch { return { kind: "failed", reason: "process_failed", detail: "Kimi login could not start" }; }
  finally { state.settled = true; bounds.dispose(); child?.stop(); await child?.exited; }
}
