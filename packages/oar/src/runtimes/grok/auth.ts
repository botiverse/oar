import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginOptions, LoginResult, LogoutOptions, LogoutResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { errorMessage, LoginSecrets, loginBounds, loginExecutable, spawnLoginProcess, stoppedResult, type LoginProcess, type LoginProcessExit, type LoginStop } from "../../shared/login.js";
import { commandLogout, confirmedLogout, runLogoutCommand } from "../../shared/logout.js";

/*
 * Grok Build's own sign-in (1.0.77, 2026-11-11; docs/runtimes/grok.md#login).
 * `grok login --device-auth` prints `https://accounts.x.ai/oauth2/device?user_code=<CODE>`,
 * then the code on a line of its own, and waits ("Waiting for authorization...")
 * until the person confirms the code in a browser: nothing is pasted back.
 * Before that it starts a browser itself: `BROWSER` when set (the command,
 * with the URL), otherwise the desktop's launcher (`gio open` here). Status is
 * `grok models`, which starts with "You are not authenticated." without a
 * sign-in and "You are logged in with grok.com." with one. `grok logout` clears the cached sign-in ("No cached session to log
 * out of." when there is none, exit 0). OAR never reads or writes the
 * credential.
 */
const SOURCE = "grok models";
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const LOGOUT_TIMEOUT_MS = 60_000;
const DEVICE_URL = /^(https:\/\/accounts\.x\.ai\/oauth2\/device\?\S+)$/u;
const SIGNED_OUT = "You are not authenticated.";
/** Its first line with a sign-in (1.0.77, a real login): `You are logged in with grok.com.` */
const SIGNED_IN = /^You are logged in with (\S+?)\.$/mu;

export async function readGrokAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions & { readonly signal?: AbortSignal } = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const result = await runExecutable(installation.command, ["models"], {
    env: sessionEnvironment(options.env), timeoutMs: options.timeoutMs ?? 30_000, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!result.ok) { return { kind: "unknown", source: SOURCE, detail: "grok models failed" }; }
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes(SIGNED_OUT)) { return { kind: "logged_out", source: SOURCE }; }
  const method = SIGNED_IN.exec(output)?.[1];
  return method === undefined
    ? { kind: "unknown", source: SOURCE, detail: "grok models said neither that it is logged in nor that it is not" }
    : { kind: "logged_in", account: { method }, source: SOURCE };
}

/** Whether Grok is signed in, by its own model listing. */
export async function grokAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  const status = await withQueryDeadline<AuthStatus>("Grok auth status", options.timeoutMs ?? 30_000, async (signal) => {
    const read = await readGrokAuthStatus(installation, { ...options, signal });
    return read;
  }, { kind: "unknown", source: SOURCE, detail: "Grok auth status timed out" });
  return status;
}

type Ending =
  | { readonly kind: "exit"; readonly exit: LoginProcessExit }
  | { readonly kind: "stop"; readonly stop: LoginStop }
  | { readonly kind: "interaction_failed"; readonly message: string };

/** Exit 0 is only Grok's word: its status decides; an unanswered status leaves a login without an account. */
async function confirmed(installation: AvailableInstallation, signal: AbortSignal | undefined, env: LoginOptions["env"]): Promise<LoginResult> {
  const status = signal?.aborted === true ? undefined : await readGrokAuthStatus(installation, { env, timeoutMs: 20_000, ...(signal === undefined ? {} : { signal }) });
  return status?.kind === "logged_out"
    ? { kind: "failed", reason: "not_logged_in", detail: "grok login exited 0, yet grok models says it is not authenticated" }
    : { kind: "logged_in" };
}

/** The device URL as `device_code`: the code is its `user_code`. */
function deviceCode(url: string): { readonly kind: "device_code"; readonly userCode: string; readonly verificationUri: string } | null {
  const userCode = URL.canParse(url) ? new URL(url).searchParams.get("user_code") : null;
  return userCode === null || userCode === "" ? null : { kind: "device_code", userCode, verificationUri: url };
}

async function runGrokLogin(installation: AvailableInstallation, command: string, interaction: ProviderLoginInteraction, options: LoginOptions, env: NodeJS.ProcessEnv): Promise<LoginResult> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const secrets = new LoginSecrets();
  const interactionFailure = Promise.withResolvers<Ending>();
  const flow: { sent: boolean; lastLine: string | undefined } = { sent: false, lastLine: undefined };
  let child: LoginProcess | null = null;
  try {
    child = spawnLoginProcess(command, ["login", "--device-auth"], env, {
      onLine(line) {
        const url = DEVICE_URL.exec(line)?.[1];
        const event = url === undefined ? null : deviceCode(url);
        if (event === null) { flow.lastLine = line; return; }
        if (flow.sent) { return; }
        flow.sent = true;
        try { interaction.onEvent(event); }
        catch (error) { interactionFailure.resolve({ kind: "interaction_failed", message: errorMessage(error) }); }
      },
    });
  } catch (error) {
    return { kind: "failed", reason: "process_failed", detail: secrets.line(errorMessage(error)) };
  }
  const bounds = loginBounds(interaction.signal, timeoutMs);
  try {
    const ending = await Promise.race([
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      child.exited.then((exit): Ending => ({ kind: "exit", exit })),
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      bounds.stopped.then((stop): Ending => ({ kind: "stop", stop })),
      interactionFailure.promise,
    ]);
    if (ending.kind === "stop") { child.stop(); await child.exited; return stoppedResult(ending.stop, timeoutMs); }
    if (ending.kind === "interaction_failed") { child.stop(); await child.exited; return { kind: "failed", reason: "interaction_failed", detail: secrets.line(ending.message) }; }
    const { exit } = ending;
    if (exit.exitCode === 0 && exit.error === undefined) { return await confirmed(installation, interaction.signal, options.env); }
    if (exit.error !== undefined) { return { kind: "failed", reason: "process_failed", detail: secrets.line(exit.error) }; }
    const how = exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `code ${String(exit.exitCode)}`;
    return { kind: "failed", reason: flow.lastLine === undefined ? "process_failed" : "rejected", detail: flow.lastLine === undefined ? `grok login exited with ${how}` : secrets.line(flow.lastLine) };
  } finally { bounds.dispose(); }
}

/**
 * Signs Grok in with its own device-code login, relaying the code. With
 * `openBrowser: false`, `BROWSER` names a command that does nothing, which
 * Grok runs instead of the desktop's launcher (POSIX; Windows is refused).
 */
export async function grokLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: LoginOptions = {}): Promise<LoginResult> {
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "grok", undefined, env);
  if (target.kind === "settled") { return target.result; }
  if (interaction.signal?.aborted === true) { return { kind: "cancelled" }; }
  if (options.openBrowser === false && process.platform === "win32") {
    return { kind: "unsupported", reason: "browser_suppression_unavailable", detail: "OAR has not verified that Grok honours BROWSER on Windows; allow local browser opening" };
  }
  const result = await runGrokLogin(installation, target.installation.command, interaction, options, options.openBrowser === false ? { ...env, BROWSER: "true" } : env);
  return result;
}

/** Signs Grok out with `grok logout`; `grok models` decides. */
export async function grokLogout(installation: AvailableInstallation, options: LogoutOptions = {}): Promise<LogoutResult> {
  const env = sessionEnvironment(options.env);
  const target = loginExecutable(installation, "grok", undefined, env);
  if (target.kind === "settled") { return target.result; }
  const timeoutMs = options.timeoutMs ?? LOGOUT_TIMEOUT_MS;
  const end = await runLogoutCommand(target.installation.command, ["logout"], env, timeoutMs);
  if (end.kind === "not_started") { return { kind: "failed", reason: "process_failed", detail: end.detail }; }
  return confirmedLogout(commandLogout(end, "grok logout", timeoutMs), await readGrokAuthStatus(installation, { env: options.env }), "grok logout");
}
