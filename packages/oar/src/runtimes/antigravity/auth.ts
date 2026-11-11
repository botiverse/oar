import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions, LoginOptions, LoginResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { antigravityNoBrowserEnv } from "./login-browser.js";
import { errorMessage, LoginSecrets, loginBounds, loginExecutable, spawnLoginProcess, stoppedResult, type LoginProcess, type LoginProcessExit, type LoginStop } from "../../shared/login.js";

/*
 * Antigravity's own login (agy 1.5.5, 2026-11-10; experiments and notes in
 * docs/runtimes/antigravity.md#login). `agy acp --login` ("Log in with Google
 * interactively, then exit") prints
 *
 *   Open this link in a browser to log in with Google:
 *     https://accounts.google.com/o/oauth2/auth?...
 *   Then paste the authorization code, or the full URL of the page you land on, and press Enter:
 *
 * and reads that line from stdin; with none it ends `login cancelled: no
 * authorization code was entered` (exit 1). The CLI decides where the token
 * goes (a 0600 file under `$GEMINI_HOME/antigravity-cli/`, or a keyring it
 * detects); OAR never reads or writes it. Status is `agy models`, which
 * refuses with "Please sign in" when there is no login. There is no logout:
 * the CLI refuses `/logout` outside its interactive UI ("it clears stored
 * credentials"), so the runtime has no `logout` member.
 */
const SOURCE = "agy models";
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const URL_LINE = /^(https:\/\/accounts\.google\.com\/\S+)$/u;
const PASTE_PROMPT = /Then paste the authorization code\b/u;
const SIGNED_OUT = /Please sign in\b/iu;

export async function readAntigravityAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions & { readonly signal?: AbortSignal } = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", detail: "not a machine-installed executable" }; }
  const result = await runExecutable(installation.command, ["models"], {
    env: sessionEnvironment(options.env), timeoutMs: options.timeoutMs ?? 30_000, ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.ok) { return { kind: "logged_in", source: SOURCE }; }
  // Its refusal names the missing login; any other failure (network, a crash) says nothing about it.
  if (result.exitCode === 1 && SIGNED_OUT.test(`${result.stdout}\n${result.stderr}`)) { return { kind: "logged_out", source: SOURCE }; }
  return { kind: "unknown", source: SOURCE, detail: "agy models ended without saying whether it is signed in" };
}

/** Whether Antigravity is signed in, by its own model listing (a remote call: not localOnly). */
export async function antigravityAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  const status = await withQueryDeadline<AuthStatus>("Antigravity auth status", options.timeoutMs ?? 30_000, async (signal) => {
    const read = await readAntigravityAuthStatus(installation, { ...options, signal });
    return read;
  }, { kind: "unknown", source: SOURCE, detail: "Antigravity auth status timed out" });
  return status;
}

/** The secret query values of a pasted landing URL (`code`, also percent-decoded); none for a bare code. */
function landingCodes(answer: string): readonly string[] {
  if (!URL.canParse(answer)) { return []; }
  const value = new URL(answer).searchParams.get("code");
  if (value === null || value === "") { return []; }
  const raw = /[?&]code=([^&#]*)/u.exec(answer)?.[1];
  return [...new Set([value, ...(raw === undefined ? [] : [raw])])];
}

type Ending =
  | { readonly kind: "exit"; readonly exit: LoginProcessExit }
  | { readonly kind: "stop"; readonly stop: LoginStop }
  | { readonly kind: "interaction_failed"; readonly message: string };

/** Exit 0 is only agy's word: its status decides, and an unanswered status leaves a login without an account. */
async function confirmed(installation: AvailableInstallation, signal: AbortSignal | undefined, env: LoginOptions["env"]): Promise<LoginResult> {
  // The status query after a success is bounded like every runtime's (docs/spec/login.md: up to 20 s).
  const status = signal?.aborted === true ? undefined : await readAntigravityAuthStatus(installation, { env, timeoutMs: 20_000, ...(signal === undefined ? {} : { signal }) });
  if (status?.kind === "logged_out") {
    return { kind: "failed", reason: "not_logged_in", detail: "agy acp --login exited 0, yet agy models asks to sign in" };
  }
  return { kind: "logged_in" };
}

// oxlint-disable-next-line eslint/max-lines-per-function, eslint/max-statements -- One native flow: relay, ask, write, then settle every ending.
async function runAntigravityLogin(installation: AvailableInstallation, command: string, interaction: ProviderLoginInteraction, timeoutMs: number, options: LoginOptions, env: NodeJS.ProcessEnv): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  const interactionFailure = Promise.withResolvers<Ending>();
  const flow: { urlSent: boolean; asked: boolean; settled: boolean; lastLine: string | undefined } = { urlSent: false, asked: false, settled: false, lastLine: undefined };
  /** Read after a wait: the login may have ended while the caller answered. */
  const ended = (): boolean => flow.settled;
  let child: LoginProcess | null = null;
  const interactionFailed = (error: unknown): void => {
    flow.settled = true;
    interactionFailure.resolve({ kind: "interaction_failed", message: errorMessage(error) });
  };
  const ask = async (): Promise<void> => {
    if (flow.asked || ended()) { return; }
    flow.asked = true;
    let answer = "";
    try {
      answer = await interaction.prompt({ kind: "manual_code", message: "Paste the authorization code, or the full URL of the page you land on after signing in" });
    } catch (error) {
      if (interaction.signal?.aborted !== true) { interactionFailed(error); }
      return;
    }
    const code = answer.trim();
    if (ended()) { return; }
    // agy waits on an empty line (live 1.5.5): ask again rather than leave it waiting.
    if (code === "") { flow.asked = false; await ask(); return; }
    // The code (or a landing URL carrying it) is the secret; only agy's stdin sees it.
    secrets.add(code);
    // A pasted landing URL carries the code as a query value; agy may echo that alone.
    for (const part of landingCodes(code)) { secrets.add(part); }
    child?.write(`${code}\n`);
  };
  try {
    child = spawnLoginProcess(command, ["acp", "--login"], env, {
      onLine(line) {
        const url = URL_LINE.exec(line)?.[1];
        if (url !== undefined && !flow.urlSent) {
          flow.urlSent = true;
          try {
            interaction.onEvent({ kind: "auth_url", url, instructions: "Open this URL and sign in with Google, then paste the code the page shows (or its full address)." });
          } catch (error) { interactionFailed(error); }
          return;
        }
        if (PASTE_PROMPT.test(line)) { void ask(); return; }
        flow.lastLine = line;
      },
      onPartial(partial) { if (PASTE_PROMPT.test(partial)) { void ask(); } },
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
    flow.settled = true;
    if (ending.kind === "stop") { child.stop(); await child.exited; return stoppedResult(ending.stop, timeoutMs); }
    if (ending.kind === "interaction_failed") { child.stop(); await child.exited; return { kind: "failed", reason: "interaction_failed", detail: secrets.line(ending.message) }; }
    const { exit } = ending;
    if (exit.exitCode === 0 && exit.error === undefined) { return await confirmed(installation, interaction.signal, options.env); }
    if (exit.error !== undefined) { return { kind: "failed", reason: "process_failed", detail: secrets.line(exit.error) }; }
    const how = exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `code ${String(exit.exitCode)}`;
    return { kind: "failed", reason: exit.exitCode === 1 && flow.lastLine !== undefined ? "rejected" : "process_failed", detail: flow.lastLine === undefined ? `agy acp --login exited with ${how}` : secrets.line(flow.lastLine) };
  } finally {
    flow.settled = true;
    bounds.dispose();
  }
}

/** Signs Antigravity in with its own `agy acp --login`, relaying the Google URL and writing the pasted code to its stdin. */
export async function antigravityLogin(installation: AvailableInstallation, interaction: ProviderLoginInteraction, options: LoginOptions = {}): Promise<LoginResult> {
  const target = loginExecutable(installation, "agy", undefined, sessionEnvironment(options.env));
  if (target.kind === "settled") { return target.result; }
  if (interaction.signal?.aborted === true) { return { kind: "cancelled" }; }
  let browser: Awaited<ReturnType<typeof antigravityNoBrowserEnv>> | undefined = undefined;
  if (options.openBrowser === false) {
    try { browser = await antigravityNoBrowserEnv(sessionEnvironment(options.env)); }
    catch { return { kind: "unsupported", reason: "browser_suppression_unavailable", detail: "agy opens its own browser and this machine cannot replace its launcher; allow local browser opening" }; }
  }
  try {
    const result = await runAntigravityLogin(installation, target.installation.command, interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS, options, browser?.env ?? sessionEnvironment(options.env));
    return result;
  } finally { await browser?.dispose(); }
}
