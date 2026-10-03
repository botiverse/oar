import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  AuthStatus,
  AuthStatusOptions,
  LoginAccount,
  LoginOptions,
  LoginResult,
} from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import {
  exclusiveLogin,
  LoginSecrets,
  loginBounds,
  loginExecutable,
  spawnLoginProcess,
  stoppedResult,
  type LoginProcessExit,
  type LoginStop,
} from "../../shared/login.js";

/*
 * `claude auth login` over pipes (2.1.288). It prints, on stdout:
 *
 *   Opening browser to sign in…
 *   If the browser didn't open, visit: <url>      (an OSC 8 hyperlink from 2.1.202)
 *   Paste code here if prompted >                 (no newline)
 *
 * and races two ends: the browser's redirect to its localhost listener, and a
 * `code#state` line on stdin, which the page behind <url> shows after the
 * sign-in. A malformed line prints `Invalid code. Please make sure the full
 * code was copied.` to stderr and reading goes on. It ends with
 * `Login successful.` (exit 0) or `Login failed: <message>` on stderr (exit
 * 1), and has no deadline of its own. Reading a pasted code arrived in
 * 2.1.126; `auth login` itself in 2.1.41.
 */
const PASTE_FLOOR = "2.1.126";
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const STATUS_SOURCE = "claude auth status --json";

const URL_LINE = /If the browser didn't open, visit:\s*(\S+)/u;
const PASTE_PROMPT = /Paste code here if prompted\s*>/u;
const INVALID_CODE = /Invalid code\b/u;
const SUCCESS = /Login successful\b/u;
const FAILURE = /Login failed:\s*(.*)$/u;

function claudeEnv(): NodeJS.ProcessEnv {
  // As for sessions: a claude started from inside a claude session must not think it is nested.
  return { ...process.env, CLAUDECODE: undefined };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `claude auth status --json`: `{ loggedIn, authMethod, email?, subscriptionType?, ... }`, exit 0 signed in, 1 signed out. */
export function projectClaudeAuthStatus(stdout: string): AuthStatus {
  const status = asRecord(parseJson(stdout));
  if (status === null || typeof status.loggedIn !== "boolean") {
    return { kind: "unknown", detail: "claude auth status gave no loggedIn field", source: STATUS_SOURCE };
  }
  if (!status.loggedIn) {
    return { kind: "signed_out", source: STATUS_SOURCE };
  }
  const email = text(status.email);
  const plan = text(status.subscriptionType);
  const method = text(status.authMethod);
  const account: LoginAccount = {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
    ...(method === undefined ? {} : { method }),
  };
  return { kind: "signed_in", ...(Object.keys(account).length === 0 ? {} : { account }), source: STATUS_SOURCE };
}

export async function claudeAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") {
    return { kind: "unknown", detail: "not a machine-installed executable" };
  }
  const result = await runExecutable(installation.command, ["auth", "status", "--json"], {
    env: claudeEnv(),
    timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS,
  });
  // Exit 0 signed in, 1 signed out; anything else (a timeout, a crash) is no answer.
  if (!result.ok && result.exitCode !== 1) {
    return { kind: "unknown", detail: `claude auth status ended without an answer (exit ${String(result.exitCode)})`, source: STATUS_SOURCE };
  }
  return projectClaudeAuthStatus(result.stdout);
}

interface FlowState {
  urlSent: boolean;
  /** The paste prompt was seen and the caller asked once; later asks follow an `Invalid code`. */
  pasteOffered: boolean;
  /** One question to the caller at a time. */
  promptOpen: boolean;
  /** The login has ended; a late answer is dropped, never written. */
  settled: boolean;
  reportedSuccess: boolean;
  failure: string | undefined;
}

type Ending =
  | { readonly kind: "exit"; readonly exit: LoginProcessExit }
  | { readonly kind: "stop"; readonly stop: LoginStop }
  /** The caller's `prompt` or `onEvent` threw. */
  | { readonly kind: "prompt_failed"; readonly message: string };

async function verified(installation: AvailableInstallation, reportedSuccess: boolean): Promise<LoginResult> {
  const status = await claudeAuthStatus(installation);
  if (status.kind === "signed_in") {
    return { kind: "logged_in", ...(status.account === undefined ? {} : { account: status.account }) };
  }
  if (status.kind === "signed_out") {
    return { kind: "failed", reason: "not_signed_in", detail: "claude auth login exited 0, yet claude auth status says signed out" };
  }
  return reportedSuccess
    ? { kind: "logged_in" }
    : { kind: "failed", reason: "process_failed", detail: "claude auth login exited 0 without reporting success" };
}

async function runClaudeLogin(
  installation: AvailableInstallation,
  command: string,
  interaction: ProviderLoginInteraction,
  timeoutMs: number,
): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  const bounds = loginBounds(interaction.signal, timeoutMs);
  const promptFailure = Promise.withResolvers<Ending>();
  const flow: FlowState = { urlSent: false, pasteOffered: false, promptOpen: false, settled: false, reportedSuccess: false, failure: undefined };

  const ended = (): boolean => flow.settled;
  /** The caller failed: settled at once, so no answer still in flight reaches claude. */
  const interactionFailed = (error: unknown): void => {
    flow.settled = true;
    promptFailure.resolve({ kind: "prompt_failed", message: error instanceof Error ? error.message : String(error) });
  };
  const ask = async (message: string): Promise<void> => {
    if (flow.promptOpen || flow.settled) {
      return;
    }
    flow.promptOpen = true;
    let answer = "";
    try {
      answer = await interaction.prompt({ kind: "manual_code", message, placeholder: "code#state" });
    } catch (error) {
      // A prompt the caller gave up on because it aborted is a cancellation, which the bounds report.
      if (interaction.signal?.aborted !== true) {
        interactionFailed(error);
      }
      return;
    } finally {
      flow.promptOpen = false;
    }
    // The code has no whitespace; a pasted line break must not become a second attempt.
    const code = answer.replaceAll(/\s+/gu, "");
    // Read after the wait: the login may have ended while the caller answered.
    if (ended()) {
      return;
    }
    if (code === "") {
      await ask("No code was entered. Paste the code shown after signing in");
      return;
    }
    // The authorization code is the secret part; the state after `#` is already in the sign-in URL.
    secrets.add(code);
    secrets.add(code.split("#")[0] ?? code);
    // Only ever to claude's stdin: never an event, a result or an error.
    child.write(`${code}\n`);
  };
  const offerPaste = (): void => {
    if (!flow.pasteOffered) {
      flow.pasteOffered = true;
      void ask("Paste the code shown after signing in");
    }
  };

  const child = spawnLoginProcess(command, ["auth", "login"], claudeEnv(), {
    onLine(line) {
      const url = URL_LINE.exec(line)?.[1];
      if (url !== undefined && !flow.urlSent) {
        flow.urlSent = true;
        try {
          interaction.onEvent({ kind: "auth_url", url, instructions: "Open this URL and sign in; if the page then shows a code, paste it back." });
        } catch (error) {
          // A caller that cannot show the URL cannot finish the login.
          interactionFailed(error);
        }
      }
      if (PASTE_PROMPT.test(line)) {
        offerPaste();
      }
      if (INVALID_CODE.test(line)) {
        void ask("That code was not accepted. Paste the full code shown after signing in");
      }
      if (SUCCESS.test(line)) {
        flow.reportedSuccess = true;
      }
      const failed = FAILURE.exec(line)?.[1];
      if (failed !== undefined) {
        flow.failure = failed;
      }
    },
    onPartial(partial) {
      if (PASTE_PROMPT.test(partial)) {
        offerPaste();
      }
    },
  });

  try {
    const ending = await Promise.race([
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      child.exited.then((exit): Ending => ({ kind: "exit", exit })),
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      bounds.stopped.then((stop): Ending => ({ kind: "stop", stop })),
      promptFailure.promise,
    ]);
    flow.settled = true;
    if (ending.kind !== "exit") {
      child.stop();
      await child.exited;
      return ending.kind === "stop"
        ? stoppedResult(ending.stop, timeoutMs)
        : { kind: "failed", reason: "interaction_failed", detail: secrets.redact(ending.message) };
    }
    const { exit } = ending;
    if (exit.error !== undefined) {
      return { kind: "failed", reason: "process_failed", detail: secrets.redact(exit.error) };
    }
    if (exit.exitCode === 0) {
      return await verified(installation, flow.reportedSuccess);
    }
    if (flow.failure !== undefined) {
      return { kind: "failed", reason: "rejected", detail: secrets.redact(flow.failure) };
    }
    return {
      kind: "failed",
      reason: "process_failed",
      detail: `claude auth login exited with ${exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `code ${String(exit.exitCode)}`}`,
    };
  } finally {
    flow.settled = true;
    bounds.dispose();
  }
}

/** Signs claude in with `claude auth login`, relaying its URL and writing the pasted code to its stdin. */
export async function claudeLogin(
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const target = loginExecutable(installation, "claude", PASTE_FLOOR);
  if (target.kind === "unsupported") {
    return target.result;
  }
  if (interaction.signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const result = await exclusiveLogin("claude", async () => {
    const outcome = await runClaudeLogin(installation, target.installation.command, interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    return outcome;
  });
  return result;
}
